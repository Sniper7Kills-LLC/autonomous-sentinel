import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type MessageMutationsDataClient,
  type MessageRow,
  type ReputationRow,
  type UserRow,
} from './handler';

/**
 * Lambda-resolver tests for the `softDeleteMessage` custom mutation
 * (sub-task of #28). Mirrors the `banUser` / `selfDelete` shape so
 * the cross-cutting `audit()` helper (#258) is the sole writer of the
 * `MESSAGE_DELETE` AuditLog row.
 */

function makeEvent(
  overrides: Partial<AppSyncResolverEvent<Record<string, unknown>>> & {
    fieldName?: string;
  } = {},
): AppSyncResolverEvent<Record<string, unknown>> {
  const { fieldName = 'softDeleteMessage', ...rest } = overrides;
  const base: AppSyncResolverEvent<Record<string, unknown>> = {
    arguments: {},
    identity: {
      sub: 'cog-admin-001',
      issuer: 'https://cognito',
      username: 'admin',
      claims: {},
      sourceIp: ['203.0.113.1'],
      defaultAuthStrategy: 'ALLOW',
      groups: ['admin'],
    },
    source: null,
    request: {
      headers: { 'x-forwarded-for': '203.0.113.1', 'user-agent': 'TestAgent/1.0' },
      domainName: null,
    },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Mutation',
      fieldName,
      variables: {},
    },
    prev: null,
    stash: {},
  };
  return { ...base, ...rest };
}

interface MakeStubsResult {
  client: MessageMutationsDataClient;
  getSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  listBySubmitterSpy: ReturnType<typeof vi.fn>;
  userGetSpy: ReturnType<typeof vi.fn>;
  reputationGetSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
  messages: Map<string, MessageRow>;
  users: Map<string, UserRow>;
  reputations: Map<string, ReputationRow>;
  recentBySubmitter: Map<string, MessageRow[]>;
}

function makeStubs(
  opts: {
    existing?: MessageRow | null;
    users?: UserRow[];
    reputations?: ReputationRow[];
    recentBySubmitter?: Record<string, MessageRow[]>;
  } = {},
): MakeStubsResult {
  const messages = new Map<string, MessageRow>();
  if (opts.existing) {
    messages.set(opts.existing.id, opts.existing);
  }
  const users = new Map<string, UserRow>();
  for (const u of opts.users ?? []) users.set(u.cognitoSub, u);
  const reputations = new Map<string, ReputationRow>();
  for (const r of opts.reputations ?? []) reputations.set(r.userId, r);
  const recentBySubmitter = new Map<string, MessageRow[]>(
    Object.entries(opts.recentBySubmitter ?? {}),
  );

  const getSpy = vi.fn((input: { id: string }) =>
    Promise.resolve({ data: messages.get(input.id) ?? null, errors: undefined }),
  );
  const updateSpy = vi.fn((input: Partial<MessageRow> & { id: string }) => {
    const before = messages.get(input.id);
    const merged: MessageRow = { ...(before ?? { id: input.id }), ...input };
    messages.set(input.id, merged);
    return Promise.resolve({ data: merged, errors: undefined });
  });
  let createSeq = 0;
  const createSpy = vi.fn((input: Partial<MessageRow>) => {
    const id = `msg-created-${++createSeq}`;
    const row: MessageRow = { id, ...input };
    messages.set(id, row);
    return Promise.resolve({ data: row, errors: undefined });
  });
  const listBySubmitterSpy = vi.fn(
    (input: { submitterId: string; submittedAt?: { ge?: string; gt?: string } }) => {
      const list = recentBySubmitter.get(input.submitterId) ?? [];
      return Promise.resolve({ data: list, errors: undefined });
    },
  );
  const userGetSpy = vi.fn((input: { cognitoSub: string }) =>
    Promise.resolve({ data: users.get(input.cognitoSub) ?? null, errors: undefined }),
  );
  const reputationGetSpy = vi.fn((input: { userId: string }) =>
    Promise.resolve({ data: reputations.get(input.userId) ?? null, errors: undefined }),
  );
  const auditSpy = vi.fn(() => Promise.resolve('audit-id-1'));
  return {
    client: {
      models: {
        Message: {
          get: getSpy,
          update: updateSpy,
          create: createSpy,
          listMessageBySubmitterId: listBySubmitterSpy,
        },
        User: { get: userGetSpy },
        Reputation: { get: reputationGetSpy },
      },
    },
    getSpy,
    updateSpy,
    createSpy,
    listBySubmitterSpy,
    userGetSpy,
    reputationGetSpy,
    auditSpy,
    messages,
    users,
    reputations,
    recentBySubmitter,
  };
}

describe('messageMutations — dispatch', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('rejects an unknown fieldName', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ fieldName: 'somethingElse' });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/fieldName/i);
  });
});

describe('messageMutations — softDeleteMessage', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('admin-only: rejects when caller is not in the admin group', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({
      existing: { id: 'msg-1', deletedAt: null },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'msg-1', reason: 'spam' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['member'];
    }
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/admin/i);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('throws when the target Message does not exist', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({});
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'no-such-msg', reason: 'spam' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not found/i);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('throws when messageId argument is missing', async () => {
    const { client, auditSpy } = makeStubs({});
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { reason: 'spam' } });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/messageId/i);
  });

  it('sets deletedAt / deletedBy / deletedReason on the target', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({
      existing: { id: 'msg-42', deletedAt: null, body: 'sensitive content' },
    });
    __setDeps({
      dataClient: client,
      audit: auditSpy,
      now: () => new Date('2026-05-16T23:00:00.000Z'),
    });
    const event = makeEvent({
      arguments: { messageId: 'msg-42', reason: 'PII leak — hard-coded sub in body' },
    });
    await handler(event, {} as Context, () => undefined);

    const patch = updateSpy.mock.calls[0]?.[0] as MessageRow;
    expect(patch.id).toBe('msg-42');
    expect(patch.deletedAt).toBe('2026-05-16T23:00:00.000Z');
    expect(patch.deletedBy).toBe('cog-admin-001');
    expect(patch.deletedReason).toBe('PII leak — hard-coded sub in body');
  });

  it('writes a MESSAGE_DELETE AuditLog with before/after + reason', async () => {
    const { client, auditSpy } = makeStubs({
      existing: { id: 'msg-7', deletedAt: null, body: 'old body' },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'msg-7', reason: 'rule-violation' },
    });
    await handler(event, {} as Context, () => undefined);

    expect(auditSpy).toHaveBeenCalledOnce();
    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('MESSAGE_DELETE');
    expect(opts.targetType).toBe('Message');
    expect(opts.targetId).toBe('msg-7');
    expect(opts.reason).toBe('rule-violation');

    const before = opts.before as MessageRow;
    expect(before.deletedAt).toBeFalsy();
    const after = opts.after as MessageRow;
    expect(after.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('normalises empty reason as null on both row + audit (review-pattern from #269)', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({
      existing: { id: 'msg-9', deletedAt: null },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { messageId: 'msg-9', reason: '' } });
    await handler(event, {} as Context, () => undefined);

    const patch = updateSpy.mock.calls[0]?.[0] as MessageRow;
    expect(patch.deletedReason).toBeNull();
    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.reason).toBeNull();
  });

  it('is idempotent: re-call on already-deleted row returns it without re-writing', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({
      existing: {
        id: 'msg-already',
        deletedAt: '2025-01-01T00:00:00.000Z',
        deletedBy: 'cog-prior-admin',
      },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'msg-already', reason: 'second-try' },
    });
    const result = (await handler(event, {} as Context, () => undefined)) as MessageRow;
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(result.deletedBy).toBe('cog-prior-admin');
    expect(result.deletedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('returns the soft-deleted Message row', async () => {
    const { client, auditSpy } = makeStubs({
      existing: { id: 'msg-r', deletedAt: null },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { messageId: 'msg-r', reason: 'returning' },
    });
    const result = (await handler(event, {} as Context, () => undefined)) as MessageRow;
    expect(result.id).toBe('msg-r');
    expect(result.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(result.deletedBy).toBe('cog-admin-001');
    expect(result.deletedReason).toBe('returning');
  });
});

/**
 * `submitRecordingLessMessage` tests (#285) — witness-account
 * submission gated by ban + per-day rate-limit + reputation. Every
 * landed Message keeps `flaggedForReview = true`; `publishedAt`
 * decides queued vs. visible.
 */
describe('messageMutations — submitRecordingLessMessage', () => {
  const fixedNow = new Date('2026-05-17T12:00:00.000Z');

  function memberEvent(
    args: Record<string, unknown>,
  ): AppSyncResolverEvent<Record<string, unknown>> {
    const ev = makeEvent({ fieldName: 'submitRecordingLessMessage', arguments: args });
    if (ev.identity && 'groups' in ev.identity) {
      ev.identity.sub = 'cog-member-001';
      ev.identity.groups = ['member'];
    }
    return ev;
  }
  function modEvent(args: Record<string, unknown>): AppSyncResolverEvent<Record<string, unknown>> {
    const ev = makeEvent({ fieldName: 'submitRecordingLessMessage', arguments: args });
    if (ev.identity && 'groups' in ev.identity) {
      ev.identity.sub = 'cog-mod-001';
      ev.identity.groups = ['moderator'];
    }
    return ev;
  }
  function adminEvent(
    args: Record<string, unknown>,
  ): AppSyncResolverEvent<Record<string, unknown>> {
    return makeEvent({ fieldName: 'submitRecordingLessMessage', arguments: args });
  }

  beforeEach(() => {
    __resetDeps();
  });

  it('rejects when caller is not signed in', async () => {
    const stubs = makeStubs();
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: fixedNow.toISOString() });
    ev.identity = null;
    await expect(handler(ev, {} as Context, () => undefined)).rejects.toThrow(/not signed in/);
    expect(stubs.createSpy).not.toHaveBeenCalled();
    expect(stubs.auditSpy).not.toHaveBeenCalled();
  });

  it('rejects when broadcastTs argument is missing', async () => {
    const stubs = makeStubs();
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({});
    await expect(handler(ev, {} as Context, () => undefined)).rejects.toThrow(/broadcastTs/);
  });

  it('rejects when broadcastTs is not ISO-8601 parseable', async () => {
    const stubs = makeStubs();
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: 'not-a-date' });
    await expect(handler(ev, {} as Context, () => undefined)).rejects.toThrow(/ISO-8601/);
  });

  it('rejects an unknown message type enum value', async () => {
    const stubs = makeStubs();
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: fixedNow.toISOString(), type: 'BOGUS' });
    await expect(handler(ev, {} as Context, () => undefined)).rejects.toThrow(
      /unknown message type/,
    );
  });

  it('rejects banned callers (User.bannedAt set)', async () => {
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-member-001', bannedAt: '2026-01-01T00:00:00.000Z' }],
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: fixedNow.toISOString() });
    await expect(handler(ev, {} as Context, () => undefined)).rejects.toThrow(/banned/);
    expect(stubs.createSpy).not.toHaveBeenCalled();
    expect(stubs.auditSpy).not.toHaveBeenCalled();
  });

  it('happy path (high-rep member): publishes immediately + flagged + audits', async () => {
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-member-001' }],
      reputations: [{ userId: 'cog-member-001', computedWeight: 3 }],
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({
      broadcastTs: '2026-05-17T11:30:00.000Z',
      sender: 'SKYKING',
      receiver: 'ALLSTATIONS',
      type: 'SKYKING',
      body: 'WHISKEY TANGO',
    });
    const result = (await handler(ev, {} as Context, () => undefined)) as MessageRow;
    expect(result.flaggedForReview).toBe(true);
    expect(result.publishedAt).toBe(fixedNow.toISOString());
    expect(result.submitterId).toBe('cog-member-001');
    expect(result.submittedAt).toBe(fixedNow.toISOString());
    expect(result.sender).toBe('SKYKING');
    expect(result.body).toBe('WHISKEY TANGO');
    expect(stubs.auditSpy).toHaveBeenCalledOnce();
    const auditOpts = stubs.auditSpy.mock.calls[0]?.[1] as {
      action: string;
      after: { verification: { outcome: string; reputationWeight: number; role: string } };
    };
    expect(auditOpts.action).toBe('MESSAGE_SUBMIT_RECORDINGLESS');
    expect(auditOpts.after.verification.outcome).toBe('PUBLISHED');
    expect(auditOpts.after.verification.role).toBe('member');
    expect(auditOpts.after.verification.reputationWeight).toBe(3);
  });

  it('low-rep member is queued (publishedAt=null) but still flagged + audited', async () => {
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-member-001' }],
      reputations: [{ userId: 'cog-member-001', computedWeight: 1 }],
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: '2026-05-17T11:30:00.000Z' });
    const result = (await handler(ev, {} as Context, () => undefined)) as MessageRow;
    expect(result.flaggedForReview).toBe(true);
    expect(result.publishedAt).toBeNull();
    const auditOpts = stubs.auditSpy.mock.calls[0]?.[1] as {
      after: { verification: { outcome: string } };
    };
    expect(auditOpts.after.verification.outcome).toBe('QUEUED');
  });

  it('member with no Reputation row defaults to weight=1 (queued)', async () => {
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-member-001' }],
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: '2026-05-17T11:30:00.000Z' });
    const result = (await handler(ev, {} as Context, () => undefined)) as MessageRow;
    expect(result.publishedAt).toBeNull();
  });

  it('moderator bypasses the reputation gate (auto-publish even with low rep)', async () => {
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-mod-001' }],
      reputations: [{ userId: 'cog-mod-001', computedWeight: 0.5 }],
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = modEvent({ broadcastTs: '2026-05-17T11:30:00.000Z' });
    const result = (await handler(ev, {} as Context, () => undefined)) as MessageRow;
    expect(result.publishedAt).toBe(fixedNow.toISOString());
    const auditOpts = stubs.auditSpy.mock.calls[0]?.[1] as {
      after: { verification: { role: string; outcome: string } };
    };
    expect(auditOpts.after.verification.role).toBe('moderator');
    expect(auditOpts.after.verification.outcome).toBe('PUBLISHED');
  });

  it('admin bypasses both the rate-limit and the reputation gate', async () => {
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-admin-001' }],
      // Pre-seed 999 prior submissions — admin still sails through.
      recentBySubmitter: {
        'cog-admin-001': Array.from({ length: 999 }, (_, i) => ({
          id: `prior-${i}`,
          submitterId: 'cog-admin-001',
        })),
      },
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = adminEvent({ broadcastTs: '2026-05-17T11:30:00.000Z' });
    const result = (await handler(ev, {} as Context, () => undefined)) as MessageRow;
    expect(result.publishedAt).toBe(fixedNow.toISOString());
    // Admin path skips the GSI count entirely (cap=Infinity).
    expect(stubs.listBySubmitterSpy).not.toHaveBeenCalled();
    const auditOpts = stubs.auditSpy.mock.calls[0]?.[1] as {
      after: { verification: { role: string; rateLimitCap: number | null } };
    };
    expect(auditOpts.after.verification.role).toBe('admin');
    expect(auditOpts.after.verification.rateLimitCap).toBeNull();
  });

  it('member rate-limit: rejects when prior 24h submissions hit the cap (default 5)', async () => {
    const priors = Array.from({ length: 5 }, (_, i) => ({
      id: `prior-${i}`,
      submitterId: 'cog-member-001',
      submittedAt: '2026-05-17T06:00:00.000Z',
    }));
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-member-001' }],
      reputations: [{ userId: 'cog-member-001', computedWeight: 5 }],
      recentBySubmitter: { 'cog-member-001': priors },
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: '2026-05-17T11:30:00.000Z' });
    await expect(handler(ev, {} as Context, () => undefined)).rejects.toThrow(
      /rate limit exceeded/,
    );
    expect(stubs.createSpy).not.toHaveBeenCalled();
    expect(stubs.auditSpy).not.toHaveBeenCalled();
  });

  it('moderator rate-limit cap higher than member cap (default 20)', async () => {
    // 10 prior submissions exceeds member cap of 5 but stays well
    // under the moderator cap of 20 — should pass for a mod.
    const priors = Array.from({ length: 10 }, (_, i) => ({
      id: `prior-${i}`,
      submitterId: 'cog-mod-001',
      submittedAt: '2026-05-17T06:00:00.000Z',
    }));
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-mod-001' }],
      recentBySubmitter: { 'cog-mod-001': priors },
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = modEvent({ broadcastTs: '2026-05-17T11:30:00.000Z' });
    const result = (await handler(ev, {} as Context, () => undefined)) as MessageRow;
    expect(result.publishedAt).toBe(fixedNow.toISOString());
  });

  it('rate-limit GSI is queried with the trailing-window submittedAt predicate', async () => {
    const stubs = makeStubs({
      users: [{ cognitoSub: 'cog-member-001' }],
      reputations: [{ userId: 'cog-member-001', computedWeight: 3 }],
    });
    __setDeps({ dataClient: stubs.client, audit: stubs.auditSpy, now: () => fixedNow });
    const ev = memberEvent({ broadcastTs: '2026-05-17T11:30:00.000Z' });
    await handler(ev, {} as Context, () => undefined);
    const call = stubs.listBySubmitterSpy.mock.calls[0]?.[0] as {
      submitterId: string;
      submittedAt: { ge?: string };
    };
    expect(call.submitterId).toBe('cog-member-001');
    // Trailing 24h window: now (12:00) - 24h = previous day 12:00.
    expect(call.submittedAt.ge).toBe('2026-05-16T12:00:00.000Z');
  });
});
