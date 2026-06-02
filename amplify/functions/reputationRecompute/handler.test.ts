import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DynamoDBStreamEvent, Context } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  handler,
  computeWeight,
  roleBonusFor,
  userToRecompute,
  recomputeReputation,
  repConstants,
  __setDeps,
  __resetDeps,
  type ReputationDataClient,
} from './handler';

const context = {} as Context;
const cb = () => undefined;

describe('reputationRecompute — computeWeight (#480)', () => {
  const C = repConstants();

  it('matches the CLAUDE.md formula for a plain member', () => {
    // base 1 + 0.1*3 + 0.5*2 + 0 = 2.3
    expect(
      computeWeight({ validatedSubmissions: 3, acceptedCorrections: 2, roleBonus: 0 }, C),
    ).toBe(2.3);
  });

  it('caps submission + correction contributions and the net weight', () => {
    // 0.1*min(1000,40)=4 ; 0.5*min(1000,10)=5 ; base1 ; +admin2 => 12 → capped 5
    expect(
      computeWeight({ validatedSubmissions: 1000, acceptedCorrections: 1000, roleBonus: 2 }, C),
    ).toBe(5);
  });

  it('applies role bonus', () => {
    // base1 + 0 + 0 + 1(mod) = 2
    expect(
      computeWeight({ validatedSubmissions: 0, acceptedCorrections: 0, roleBonus: 1 }, C),
    ).toBe(2);
  });

  it('maps roles to bonuses', () => {
    expect(roleBonusFor('admin')).toBe(2);
    expect(roleBonusFor('moderator')).toBe(1);
    expect(roleBonusFor('member')).toBe(0);
    expect(roleBonusFor(null)).toBe(0);
  });
});

function recordingRecord(newImg: Record<string, unknown>, oldImg?: Record<string, unknown>) {
  return {
    dynamodb: {
      NewImage: marshall(newImg),
      OldImage: oldImg ? marshall(oldImg) : undefined,
    },
  };
}

describe('reputationRecompute — userToRecompute (#480)', () => {
  it('fires on a Recording transitioning to PUBLISHED', () => {
    expect(
      userToRecompute(
        recordingRecord(
          { uploaderId: 'u1', transcriptionStatus: 'PUBLISHED' },
          { uploaderId: 'u1', transcriptionStatus: 'PARSING' },
        ),
      ),
    ).toBe('u1');
  });

  it('ignores a Recording already PUBLISHED (no transition)', () => {
    expect(
      userToRecompute(
        recordingRecord(
          { uploaderId: 'u1', transcriptionStatus: 'PUBLISHED' },
          { uploaderId: 'u1', transcriptionStatus: 'PUBLISHED' },
        ),
      ),
    ).toBeNull();
  });

  it('ignores a non-publish Recording write', () => {
    expect(
      userToRecompute(recordingRecord({ uploaderId: 'u1', transcriptionStatus: 'TRANSCRIBING' })),
    ).toBeNull();
  });

  it('fires on a TranscriptRevision becoming accepted', () => {
    expect(
      userToRecompute(
        recordingRecord(
          { proposedBy: 'u2', accepted: true },
          { proposedBy: 'u2', accepted: false },
        ),
      ),
    ).toBe('u2');
  });

  it('ignores an already-accepted revision', () => {
    expect(
      userToRecompute(
        recordingRecord({ proposedBy: 'u2', accepted: true }, { proposedBy: 'u2', accepted: true }),
      ),
    ).toBeNull();
  });
});

function makeClient(opts: {
  publishedRecordings?: string[];
  acceptedRevisions?: boolean[];
  role?: string;
}) {
  const update = vi.fn().mockResolvedValue({ data: {} });
  const client: ReputationDataClient = {
    models: {
      Recording: {
        listRecordingByUploaderId: vi.fn().mockResolvedValue({
          data: (opts.publishedRecordings ?? []).map((s) => ({ transcriptionStatus: s })),
          nextToken: null,
        }),
      },
      TranscriptRevision: {
        listTranscriptRevisionByProposedBy: vi.fn().mockResolvedValue({
          data: (opts.acceptedRevisions ?? []).map((a) => ({ accepted: a })),
          nextToken: null,
        }),
      },
      User: { get: vi.fn().mockResolvedValue({ data: { role: opts.role ?? 'member' } }) },
      Reputation: { update },
    },
  };
  return { client, update };
}

describe('reputationRecompute — recomputeReputation (#480)', () => {
  it('counts only PUBLISHED recordings + accepted revisions and writes the weight', async () => {
    const { client, update } = makeClient({
      publishedRecordings: ['PUBLISHED', 'PARSING', 'PUBLISHED', 'FAILED'],
      acceptedRevisions: [true, false, true],
      role: 'member',
    });
    const weight = await recomputeReputation(client, 'u1');
    // base1 + 0.1*2 + 0.5*2 = 2.2
    expect(weight).toBe(2.2);
    expect(update).toHaveBeenCalledWith({
      userId: 'u1',
      validatedSubmissions: 2,
      acceptedCorrections: 2,
      roleBonus: 0,
      computedWeight: 2.2,
    });
  });

  it('includes the role bonus for a moderator', async () => {
    const { client, update } = makeClient({ role: 'moderator' });
    await recomputeReputation(client, 'mod-1');
    // base1 + mod1 = 2 with no submissions
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ roleBonus: 1, computedWeight: 2 }),
    );
  });
});

describe('reputationRecompute — handler (#480)', () => {
  beforeEach(() => {
    __resetDeps();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('recomputes once per distinct affected user in the batch', async () => {
    const { client, update } = makeClient({
      publishedRecordings: ['PUBLISHED'],
      acceptedRevisions: [],
      role: 'member',
    });
    __setDeps({ client });
    const event = {
      Records: [
        recordingRecord(
          { uploaderId: 'u1', transcriptionStatus: 'PUBLISHED' },
          { uploaderId: 'u1', transcriptionStatus: 'PARSING' },
        ),
        recordingRecord(
          { proposedBy: 'u1', accepted: true },
          { proposedBy: 'u1', accepted: false },
        ),
        recordingRecord({ uploaderId: 'u1', transcriptionStatus: 'TRANSCRIBING' }), // no-op
      ],
    } as unknown as DynamoDBStreamEvent;

    await handler(event, context, cb);
    // u1 appears twice (recording + revision) → deduped to one recompute.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('no-ops on a batch with no relevant transitions', async () => {
    const { client, update } = makeClient({});
    __setDeps({ client });
    const event = {
      Records: [recordingRecord({ uploaderId: 'u1', transcriptionStatus: 'QUEUED' })],
    } as unknown as DynamoDBStreamEvent;
    await handler(event, context, cb);
    expect(update).not.toHaveBeenCalled();
  });
});
