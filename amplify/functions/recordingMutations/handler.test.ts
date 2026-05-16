import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type RecordingMutationsDataClient,
  type RecordingRow,
} from './handler';

/**
 * Lambda-resolver tests for the `softDeleteRecording` custom mutation
 * (#29). Mirrors the `softDeleteMessage` shape from #28.
 *
 * Recording rows carry `deletedAt` + `deletedBy` but no
 * `deletedReason` column (the reason lives only on the AuditLog
 * entry — same pattern as Message but the column is intentionally
 * absent here per the model definition in #257).
 */

function makeEvent(
  overrides: Partial<AppSyncResolverEvent<Record<string, unknown>>> & {
    fieldName?: string;
  } = {},
): AppSyncResolverEvent<Record<string, unknown>> {
  const { fieldName = 'softDeleteRecording', ...rest } = overrides;
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

function makeStubs(opts: { existing?: RecordingRow | null } = {}): {
  client: RecordingMutationsDataClient;
  getSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
} {
  const recordings = new Map<string, RecordingRow>();
  if (opts.existing) recordings.set(opts.existing.id, opts.existing);
  const getSpy = vi.fn((input: { id: string }) =>
    Promise.resolve({ data: recordings.get(input.id) ?? null, errors: undefined }),
  );
  const updateSpy = vi.fn((input: Partial<RecordingRow> & { id: string }) => {
    const before = recordings.get(input.id);
    const merged: RecordingRow = { ...(before ?? { id: input.id }), ...input };
    recordings.set(input.id, merged);
    return Promise.resolve({ data: merged, errors: undefined });
  });
  const auditSpy = vi.fn(() => Promise.resolve('audit-id'));
  return {
    client: { models: { Recording: { get: getSpy, update: updateSpy } } },
    getSpy,
    updateSpy,
    auditSpy,
  };
}

describe('recordingMutations — dispatch', () => {
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

describe('recordingMutations — softDeleteRecording', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('admin-only: rejects when caller is not in the admin group', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({
      existing: { id: 'rec-1', deletedAt: null },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-1', reason: 'illegal-content' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['member'];
    }
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/admin/i);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('throws when the target Recording does not exist', async () => {
    const { client, auditSpy } = makeStubs({});
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'no-such-rec', reason: 'X' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not found/i);
  });

  it('throws when recordingId argument is missing', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { reason: 'X' } });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/recordingId/i);
  });

  it('sets deletedAt + deletedBy on the target', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({
      existing: { id: 'rec-42', deletedAt: null, contentHash: 'abc' },
    });
    __setDeps({
      dataClient: client,
      audit: auditSpy,
      now: () => new Date('2026-05-16T23:45:00.000Z'),
    });
    const event = makeEvent({
      arguments: { recordingId: 'rec-42', reason: 'low-quality' },
    });
    await handler(event, {} as Context, () => undefined);

    const patch = updateSpy.mock.calls[0]?.[0] as RecordingRow;
    expect(patch.id).toBe('rec-42');
    expect(patch.deletedAt).toBe('2026-05-16T23:45:00.000Z');
    expect(patch.deletedBy).toBe('cog-admin-001');
  });

  it('writes a RECORDING_DELETE audit with before/after + reason', async () => {
    const { client, auditSpy } = makeStubs({
      existing: { id: 'rec-7', deletedAt: null, contentHash: 'xyz' },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-7', reason: 'duplicate-upload' },
    });
    await handler(event, {} as Context, () => undefined);

    expect(auditSpy).toHaveBeenCalledOnce();
    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('RECORDING_DELETE');
    expect(opts.targetType).toBe('Recording');
    expect(opts.targetId).toBe('rec-7');
    expect(opts.reason).toBe('duplicate-upload');

    const before = opts.before as RecordingRow;
    expect(before.deletedAt).toBeFalsy();
    const after = opts.after as RecordingRow;
    expect(after.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('normalises empty reason as null on the audit entry', async () => {
    const { client, auditSpy } = makeStubs({
      existing: { id: 'rec-9', deletedAt: null },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { recordingId: 'rec-9', reason: '' } });
    await handler(event, {} as Context, () => undefined);

    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.reason).toBeNull();
  });

  it('is idempotent: re-call on already-deleted row returns it without re-writing', async () => {
    const { client, auditSpy, updateSpy } = makeStubs({
      existing: {
        id: 'rec-already',
        deletedAt: '2025-01-01T00:00:00.000Z',
        deletedBy: 'cog-prior-admin',
      },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-already', reason: 'second-try' },
    });
    const result = (await handler(event, {} as Context, () => undefined)) as RecordingRow;
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(result.deletedBy).toBe('cog-prior-admin');
  });

  it('returns the soft-deleted Recording row', async () => {
    const { client, auditSpy } = makeStubs({
      existing: { id: 'rec-r', deletedAt: null },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { recordingId: 'rec-r', reason: 'X' } });
    const result = (await handler(event, {} as Context, () => undefined)) as RecordingRow;
    expect(result.id).toBe('rec-r');
    expect(result.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(result.deletedBy).toBe('cog-admin-001');
  });
});

describe('recordingMutations — no cascade to parent Message (#29 revised)', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('does not touch the parent Message even when this was the last live recording', async () => {
    // CLAUDE.md domain rule was reversed: v3 archive carries
    // Messages with no Recording (analytics) and v4 supports
    // recording-less submissions (gated by anti-spam verification).
    // Deleting a Recording is therefore a row-local op; the parent
    // Message keeps standing regardless of the sibling count.
    const { client, auditSpy } = makeStubs({
      existing: { id: 'rec-last', messageId: 'msg-1', deletedAt: null },
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-last', reason: 'illegal-content' },
    });
    await handler(event, {} as Context, () => undefined);

    // Exactly one audit entry: RECORDING_DELETE. No MESSAGE_DELETE
    // cascade. The handler's data client shape was deliberately
    // narrowed to expose Recording only — accessing Message here
    // would be a typecheck error.
    expect(auditSpy).toHaveBeenCalledOnce();
    const [, opts] = auditSpy.mock.calls[0] as [unknown, { action: string }];
    expect(opts.action).toBe('RECORDING_DELETE');
  });
});
