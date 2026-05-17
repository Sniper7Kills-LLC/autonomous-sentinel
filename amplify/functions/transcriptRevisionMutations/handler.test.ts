import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type TranscriptRevisionMutationsDataClient,
  type TranscriptRevisionRow,
  type RecordingRow,
} from './handler';

/**
 * Lambda-resolver tests for TranscriptRevision custom mutations (#287 / #34).
 *
 * Two mutations:
 *   - `submitTranscriptRevision` — authenticated. Gates creation on
 *     `Recording.transcriptionFailed=true` per CLAUDE.md "Manual
 *     transcription" rule.
 *   - `acceptTranscriptRevision` — admin/mod. Sets `accepted=true`,
 *     cascades `superseded=true` to all sibling revisions on the
 *     same Recording, rewrites `Recording.transcript`. Emits
 *     `MESSAGE_EDIT` audit (transcript change is a message-level
 *     edit from the user's perspective; the audit captures the
 *     before/after transcript).
 */

function makeEvent(
  overrides: Partial<AppSyncResolverEvent<Record<string, unknown>>> & {
    fieldName?: string;
  } = {},
): AppSyncResolverEvent<Record<string, unknown>> {
  const { fieldName = 'submitTranscriptRevision', ...rest } = overrides;
  const base: AppSyncResolverEvent<Record<string, unknown>> = {
    arguments: {},
    identity: {
      sub: 'cog-author-001',
      issuer: 'https://cognito',
      username: 'author',
      claims: {},
      sourceIp: ['203.0.113.1'],
      defaultAuthStrategy: 'ALLOW',
      groups: [],
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

function makeStubs(
  opts: {
    recordings?: RecordingRow[];
    revisions?: TranscriptRevisionRow[];
  } = {},
): {
  client: TranscriptRevisionMutationsDataClient;
  recordingGetSpy: ReturnType<typeof vi.fn>;
  recordingUpdateSpy: ReturnType<typeof vi.fn>;
  revisionGetSpy: ReturnType<typeof vi.fn>;
  revisionCreateSpy: ReturnType<typeof vi.fn>;
  revisionUpdateSpy: ReturnType<typeof vi.fn>;
  listSiblingsSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
} {
  const recordings = new Map<string, RecordingRow>();
  for (const r of opts.recordings ?? []) recordings.set(r.id, r);
  const revisions = new Map<string, TranscriptRevisionRow>();
  for (const r of opts.revisions ?? []) revisions.set(r.id, r);
  let revIdSeq = 0;

  const recordingGetSpy = vi.fn((input: { id: string }) =>
    Promise.resolve({ data: recordings.get(input.id) ?? null, errors: undefined }),
  );
  const recordingUpdateSpy = vi.fn((input: Partial<RecordingRow> & { id: string }) => {
    const before = recordings.get(input.id);
    const merged: RecordingRow = { ...(before ?? { id: input.id }), ...input };
    recordings.set(input.id, merged);
    return Promise.resolve({ data: merged, errors: undefined });
  });
  const revisionGetSpy = vi.fn((input: { id: string }) =>
    Promise.resolve({ data: revisions.get(input.id) ?? null, errors: undefined }),
  );
  const revisionCreateSpy = vi.fn((input: Omit<TranscriptRevisionRow, 'id'>) => {
    revIdSeq += 1;
    const id = `gen-rev-${revIdSeq}`;
    const row: TranscriptRevisionRow = { id, ...input } as TranscriptRevisionRow;
    revisions.set(id, row);
    return Promise.resolve({ data: row, errors: undefined });
  });
  const revisionUpdateSpy = vi.fn((input: Partial<TranscriptRevisionRow> & { id: string }) => {
    const before = revisions.get(input.id);
    const merged: TranscriptRevisionRow = {
      ...(before ?? { id: input.id }),
      ...input,
    } as TranscriptRevisionRow;
    revisions.set(input.id, merged);
    return Promise.resolve({ data: merged, errors: undefined });
  });
  const listSiblingsSpy = vi.fn((input: { recordingId: string }) => {
    const matches = Array.from(revisions.values()).filter(
      (r) => r.recordingId === input.recordingId,
    );
    return Promise.resolve({ data: matches, errors: undefined });
  });
  const auditSpy = vi.fn(() => Promise.resolve('audit-id'));
  return {
    client: {
      models: {
        Recording: { get: recordingGetSpy, update: recordingUpdateSpy },
        TranscriptRevision: {
          get: revisionGetSpy,
          create: revisionCreateSpy,
          update: revisionUpdateSpy,
          listTranscriptRevisionByRecordingIdAndVoteScore: listSiblingsSpy,
        },
      },
    },
    recordingGetSpy,
    recordingUpdateSpy,
    revisionGetSpy,
    revisionCreateSpy,
    revisionUpdateSpy,
    listSiblingsSpy,
    auditSpy,
  };
}

describe('transcriptRevisionMutations — dispatch', () => {
  beforeEach(() => __resetDeps());

  it('rejects an unknown fieldName', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ fieldName: 'somethingElse' });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/fieldName/i);
  });
});

describe('transcriptRevisionMutations — submitTranscriptRevision', () => {
  beforeEach(() => __resetDeps());

  it('rejects when caller has no identity sub', async () => {
    const { client, auditSpy } = makeStubs({
      recordings: [{ id: 'rec-1', transcriptionFailed: true }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-1', proposedText: 'hello' },
    });
    event.identity = null;
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/identity/i);
  });

  it('rejects when recordingId is missing', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { proposedText: 'hi' } });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/recordingId/i);
  });

  it('rejects when proposedText is empty', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ arguments: { recordingId: 'rec-1', proposedText: '' } });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/proposedText/i);
  });

  it('rejects when the target Recording does not exist', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'no-such-rec', proposedText: 'hi' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/Recording/);
  });

  it('rejects MANUAL submissions when Recording.transcriptionFailed is false (CLAUDE.md gate)', async () => {
    const { client, auditSpy } = makeStubs({
      recordings: [{ id: 'rec-good', transcriptionFailed: false }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-good', proposedText: 'my correction' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(
      /transcriptionFailed/i,
    );
  });

  it('allows MANUAL submission when Recording.transcriptionFailed is true', async () => {
    const { client, revisionCreateSpy, auditSpy } = makeStubs({
      recordings: [{ id: 'rec-bad', transcriptionFailed: true }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-bad', proposedText: 'hi' },
    });
    await handler(event, {} as Context, () => undefined);

    const input = revisionCreateSpy.mock.calls[0]?.[0] as TranscriptRevisionRow;
    expect(input.recordingId).toBe('rec-bad');
    expect(input.proposedText).toBe('hi');
    expect(input.proposedBy).toBe('cog-author-001');
    expect(input.source).toBe('MANUAL');
    expect(input.accepted).toBe(false);
    expect(input.superseded).toBe(false);
  });

  it('returns the created revision row', async () => {
    const { client, auditSpy } = makeStubs({
      recordings: [{ id: 'rec-bad', transcriptionFailed: true }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      arguments: { recordingId: 'rec-bad', proposedText: 'hi' },
    });
    const result = (await handler(event, {} as Context, () => undefined)) as TranscriptRevisionRow;
    expect(result.id).toMatch(/^gen-rev-/);
    expect(result.proposedBy).toBe('cog-author-001');
  });
});

describe('transcriptRevisionMutations — acceptTranscriptRevision', () => {
  beforeEach(() => __resetDeps());

  it('rejects when caller is not in moderator or admin group', async () => {
    const { client, auditSpy } = makeStubs({
      revisions: [{ id: 'rev-1', recordingId: 'rec-1', proposedText: 'accepted', proposedBy: 'X' }],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'acceptTranscriptRevision',
      arguments: { revisionId: 'rev-1' },
    });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(
      /admin|moderator/i,
    );
  });

  it('rejects when revisionId argument is missing', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({ fieldName: 'acceptTranscriptRevision', arguments: {} });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/revisionId/i);
  });

  it('rejects when the target TranscriptRevision does not exist', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'acceptTranscriptRevision',
      arguments: { revisionId: 'no-such' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not found/i);
  });

  it('flips the accepted revision to accepted=true with acceptedAt', async () => {
    const { client, revisionUpdateSpy, auditSpy } = makeStubs({
      recordings: [
        {
          id: 'rec-1',
          transcript: 'old transcript',
          transcriptionFailed: true,
          messageId: 'msg-1',
        },
      ],
      revisions: [
        {
          id: 'rev-1',
          recordingId: 'rec-1',
          proposedText: 'new transcript',
          proposedBy: 'user-1',
          source: 'MANUAL',
        },
      ],
    });
    __setDeps({
      dataClient: client,
      audit: auditSpy,
      now: () => new Date('2026-05-17T01:00:00.000Z'),
    });
    const event = makeEvent({
      fieldName: 'acceptTranscriptRevision',
      arguments: { revisionId: 'rev-1' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    const acceptedPatch = revisionUpdateSpy.mock.calls.find(
      (c) => (c[0] as { id: string }).id === 'rev-1',
    )?.[0] as TranscriptRevisionRow;
    expect(acceptedPatch.accepted).toBe(true);
    expect(acceptedPatch.acceptedAt).toBe('2026-05-17T01:00:00.000Z');
  });

  it('cascades superseded=true to all sibling revisions on the same Recording', async () => {
    const { client, revisionUpdateSpy, auditSpy } = makeStubs({
      recordings: [
        {
          id: 'rec-1',
          transcript: 'old',
          transcriptionFailed: true,
          messageId: 'msg-1',
        },
      ],
      revisions: [
        {
          id: 'rev-winner',
          recordingId: 'rec-1',
          proposedText: 'new',
          proposedBy: 'u-1',
        },
        {
          id: 'rev-loser-1',
          recordingId: 'rec-1',
          proposedText: 'other A',
          proposedBy: 'u-2',
        },
        {
          id: 'rev-loser-2',
          recordingId: 'rec-1',
          proposedText: 'other B',
          proposedBy: 'u-3',
        },
        {
          id: 'rev-other-recording',
          recordingId: 'rec-OTHER',
          proposedText: 'unrelated',
          proposedBy: 'u-4',
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'acceptTranscriptRevision',
      arguments: { revisionId: 'rev-winner' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    // rev-loser-1, rev-loser-2 should be superseded; rev-winner accepted;
    // rev-other-recording untouched.
    const updates = revisionUpdateSpy.mock.calls.map((c) => c[0] as TranscriptRevisionRow);
    const supersededIds = updates
      .filter((u) => u.superseded === true)
      .map((u) => u.id)
      .sort();
    expect(supersededIds).toEqual(['rev-loser-1', 'rev-loser-2']);

    // rev-other-recording must NOT be touched.
    expect(updates.find((u) => u.id === 'rev-other-recording')).toBeUndefined();
  });

  it('updates Recording.transcript to the accepted revision text', async () => {
    const { client, recordingUpdateSpy, auditSpy } = makeStubs({
      recordings: [
        {
          id: 'rec-1',
          transcript: 'old transcript',
          transcriptionFailed: true,
          messageId: 'msg-1',
        },
      ],
      revisions: [
        {
          id: 'rev-1',
          recordingId: 'rec-1',
          proposedText: 'new transcript',
          proposedBy: 'u-1',
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'acceptTranscriptRevision',
      arguments: { revisionId: 'rev-1' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    const patch = recordingUpdateSpy.mock.calls[0]?.[0] as RecordingRow;
    expect(patch.id).toBe('rec-1');
    expect(patch.transcript).toBe('new transcript');
  });

  it('emits a MESSAGE_EDIT audit with before/after transcript', async () => {
    const { client, auditSpy } = makeStubs({
      recordings: [
        {
          id: 'rec-1',
          transcript: 'old text',
          transcriptionFailed: true,
          messageId: 'msg-1',
        },
      ],
      revisions: [
        {
          id: 'rev-1',
          recordingId: 'rec-1',
          proposedText: 'new text',
          proposedBy: 'u-1',
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'acceptTranscriptRevision',
      arguments: { revisionId: 'rev-1' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    expect(auditSpy).toHaveBeenCalledOnce();
    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('MESSAGE_EDIT');
    // Target is the parent Recording (transcript lives there).
    expect(opts.targetType).toBe('Recording');
    expect(opts.targetId).toBe('rec-1');
    const before = opts.before as RecordingRow;
    const after = opts.after as RecordingRow;
    expect(before.transcript).toBe('old text');
    expect(after.transcript).toBe('new text');
  });

  it('is idempotent on already-accepted revisions', async () => {
    const { client, revisionUpdateSpy, recordingUpdateSpy, auditSpy } = makeStubs({
      recordings: [
        {
          id: 'rec-1',
          transcript: 'already accepted text',
          transcriptionFailed: true,
          messageId: 'msg-1',
        },
      ],
      revisions: [
        {
          id: 'rev-done',
          recordingId: 'rec-1',
          proposedText: 'already accepted text',
          proposedBy: 'u-1',
          accepted: true,
          acceptedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    __setDeps({ dataClient: client, audit: auditSpy });
    const event = makeEvent({
      fieldName: 'acceptTranscriptRevision',
      arguments: { revisionId: 'rev-done' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    const result = (await handler(event, {} as Context, () => undefined)) as TranscriptRevisionRow;
    expect(revisionUpdateSpy).not.toHaveBeenCalled();
    expect(recordingUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    expect(result.acceptedAt).toBe('2025-01-01T00:00:00.000Z');
  });
});
