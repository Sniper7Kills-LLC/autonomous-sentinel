import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type MessageMutationsDataClient,
  type MessageRow,
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

function makeStubs(opts: { existing?: MessageRow | null } = {}): {
  client: MessageMutationsDataClient;
  getSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
} {
  const messages = new Map<string, MessageRow>();
  if (opts.existing) {
    messages.set(opts.existing.id, opts.existing);
  }
  const getSpy = vi.fn((input: { id: string }) =>
    Promise.resolve({ data: messages.get(input.id) ?? null, errors: undefined }),
  );
  const updateSpy = vi.fn((input: Partial<MessageRow> & { id: string }) => {
    const before = messages.get(input.id);
    const merged: MessageRow = { ...(before ?? { id: input.id }), ...input };
    messages.set(input.id, merged);
    return Promise.resolve({ data: merged, errors: undefined });
  });
  const auditSpy = vi.fn(() => Promise.resolve('audit-id-1'));
  return {
    client: { models: { Message: { get: getSpy, update: updateSpy } } },
    getSpy,
    updateSpy,
    auditSpy,
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
