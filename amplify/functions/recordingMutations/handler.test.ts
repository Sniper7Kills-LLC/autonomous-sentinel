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

function makeStubs(opts: { existing?: RecordingRow | null; byHash?: RecordingRow[] } = {}): {
  client: RecordingMutationsDataClient;
  getSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  listByHashSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
} {
  const recordings = new Map<string, RecordingRow>();
  if (opts.existing) recordings.set(opts.existing.id, opts.existing);
  let idSeq = 0;
  const getSpy = vi.fn((input: { id: string }) =>
    Promise.resolve({ data: recordings.get(input.id) ?? null, errors: undefined }),
  );
  const createSpy = vi.fn((input: Omit<RecordingRow, 'id'>) => {
    idSeq += 1;
    const id = `gen-rec-${idSeq}`;
    const row: RecordingRow = { id, ...input };
    recordings.set(id, row);
    return Promise.resolve({ data: row, errors: undefined });
  });
  const updateSpy = vi.fn((input: Partial<RecordingRow> & { id: string }) => {
    const before = recordings.get(input.id);
    const merged: RecordingRow = { ...(before ?? { id: input.id }), ...input };
    recordings.set(input.id, merged);
    return Promise.resolve({ data: merged, errors: undefined });
  });
  const listByHashSpy = vi.fn(({ contentHash }: { contentHash: string }) =>
    Promise.resolve({
      data: (opts.byHash ?? []).filter((r) => r.contentHash === contentHash),
      errors: undefined,
    }),
  );
  const auditSpy = vi.fn(() => Promise.resolve('audit-id'));
  return {
    client: {
      models: {
        Recording: {
          get: getSpy,
          create: createSpy,
          update: updateSpy,
          listRecordingByContentHash: listByHashSpy,
        },
      },
    },
    getSpy,
    createSpy,
    updateSpy,
    listByHashSpy,
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

describe('recordingMutations — submitRecording (#284)', () => {
  beforeEach(() => __resetDeps());

  it('rejects when caller has no identity sub', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: { contentHash: 'h-1', originalKey: 's3://k/1' },
    });
    event.identity = null;
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/identity/i);
  });

  it('rejects when contentHash argument is missing', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: { originalKey: 's3://k/1' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/contentHash/i);
  });

  it('rejects when originalKey argument is missing', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: { contentHash: 'h-1' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/originalKey/i);
  });

  it('rejects a duplicate-hash upload with RECORDING_DUPLICATE_HASH (live row)', async () => {
    const { client, auditSpy, createSpy } = makeStubs({
      byHash: [{ id: 'rec-existing', contentHash: 'h-dup', uploaderId: 'someone-else' }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: { contentHash: 'h-dup', originalKey: 's3://k/2' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(
      /RECORDING_DUPLICATE_HASH/,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects a duplicate-hash upload even when the existing row is soft-deleted', async () => {
    const { client, auditSpy, createSpy } = makeStubs({
      byHash: [
        {
          id: 'rec-tombstone',
          contentHash: 'h-tomb',
          uploaderId: 'someone-else',
          deletedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: { contentHash: 'h-tomb', originalKey: 's3://k/3' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(
      /RECORDING_DUPLICATE_HASH/,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('creates the Recording with uploaderId from sub + transcriptionStatus=QUEUED on a fresh hash', async () => {
    const { client, auditSpy, createSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: { contentHash: 'h-fresh', originalKey: 's3://k/4' },
    });
    if (event.identity && 'sub' in event.identity) {
      event.identity.sub = 'cog-uploader-001';
    }
    await handler(event, {} as Context, () => undefined);

    expect(createSpy).toHaveBeenCalledOnce();
    const input = createSpy.mock.calls[0]?.[0] as RecordingRow;
    expect(input.contentHash).toBe('h-fresh');
    expect(input.originalKey).toBe('s3://k/4');
    expect(input.uploaderId).toBe('cog-uploader-001');
    expect(input.transcriptionStatus).toBe('QUEUED');
    expect(input.transcriptionFailed).toBe(false);
    expect(input.migratedFromV3).toBe(false);
  });

  it('threads through optional fields when supplied (messageId, frequencyKhz, modulation, ...)', async () => {
    const { client, auditSpy, createSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: {
        contentHash: 'h-opt',
        originalKey: 's3://k/5',
        messageId: 'msg-1',
        webCanonicalKey: 's3://web/5.opus',
        durationMs: 12345,
        frequencyKhz: 11175,
        modulation: 'USB',
        broadcastedAt: '2026-05-17T01:30:00.000Z',
        automated: true,
        sdrId: 'sdr-1',
      },
    });
    await handler(event, {} as Context, () => undefined);

    const input = createSpy.mock.calls[0]?.[0] as RecordingRow;
    expect(input.messageId).toBe('msg-1');
    expect(input.webCanonicalKey).toBe('s3://web/5.opus');
    expect(input.durationMs).toBe(12345);
    expect(input.frequencyKhz).toBe(11175);
    expect(input.modulation).toBe('USB');
    expect(input.broadcastedAt).toBe('2026-05-17T01:30:00.000Z');
    expect(input.automated).toBe(true);
    expect(input.sdrId).toBe('sdr-1');
  });

  it('throws on an invalid modulation value (handler backstop for schema enum)', async () => {
    const { client, auditSpy, createSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: {
        contentHash: 'h-bad-mod',
        originalKey: 's3://k/6',
        modulation: 'GARBAGE',
      },
    });
    // Schema-level enum already gates this at AppSync; handler
    // backstop catches direct Lambda invocations that bypass the
    // GraphQL layer. Silent-drop would mask a client bug.
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(
      /modulation must be one of/i,
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('returns the created Recording row', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'submitRecording',
      arguments: { contentHash: 'h-r', originalKey: 's3://k/r' },
    });
    const result = (await handler(event, {} as Context, () => undefined)) as RecordingRow;
    expect(result.id).toMatch(/^gen-rec-/);
    expect(result.contentHash).toBe('h-r');
  });
});
