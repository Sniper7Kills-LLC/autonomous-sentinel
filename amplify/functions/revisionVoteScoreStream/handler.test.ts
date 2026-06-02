import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DynamoDBStreamEvent, Context } from 'aws-lambda';
import {
  handler,
  computeVoteScore,
  extractRevisionIds,
  __setDeps,
  __resetDeps,
  type RevisionScoreDataClient,
} from './handler';

const context = {} as Context;
const cb = () => undefined;

function streamEvent(revisionIds: (string | undefined)[]): DynamoDBStreamEvent {
  return {
    Records: revisionIds.map((rid) => ({
      eventName: 'INSERT',
      dynamodb: { Keys: rid ? { revisionId: { S: rid }, voterId: { S: 'v1' } } : {} },
    })),
  } as unknown as DynamoDBStreamEvent;
}

describe('revisionVoteScoreStream — computeVoteScore (#653)', () => {
  it('sums UP as +weight and DOWN as -weight', () => {
    expect(
      computeVoteScore([
        { value: 'UP', weight: 1 },
        { value: 'UP', weight: 2.5 },
        { value: 'DOWN', weight: 1 },
      ]),
    ).toBe(2.5);
  });

  it('treats unknown values as 0 and non-finite weights as 0', () => {
    expect(
      computeVoteScore([
        { value: 'SIDEWAYS', weight: 5 },
        { value: 'UP', weight: Number.NaN },
        { value: 'DOWN', weight: 3 },
      ]),
    ).toBe(-3);
  });

  it('rounds away float drift', () => {
    expect(
      computeVoteScore([
        { value: 'UP', weight: 0.1 },
        { value: 'UP', weight: 0.2 },
      ]),
    ).toBe(0.3);
  });

  it('is 0 for no votes', () => {
    expect(computeVoteScore([])).toBe(0);
  });
});

describe('revisionVoteScoreStream — extractRevisionIds (#653)', () => {
  it('dedupes revisionIds across the batch and ignores keyless records', () => {
    expect(extractRevisionIds(streamEvent(['r1', 'r2', 'r1', undefined]).Records as never)).toEqual(
      ['r1', 'r2'],
    );
  });
});

describe('revisionVoteScoreStream — handler (#653)', () => {
  beforeEach(() => {
    __resetDeps();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('recomputes + writes voteScore for each affected revision', async () => {
    const update = vi.fn().mockResolvedValue({ data: { id: 'r1' } });
    const listVotes = vi.fn((rid: string) =>
      Promise.resolve(
        rid === 'r1'
          ? [
              { value: 'UP', weight: 2 },
              { value: 'DOWN', weight: 1 },
            ]
          : [{ value: 'UP', weight: 1 }],
      ),
    );
    const dataClient: RevisionScoreDataClient = { models: { TranscriptRevision: { update } } };
    __setDeps({ listVotes, dataClient });

    await handler(streamEvent(['r1', 'r2']), context, cb);

    expect(update).toHaveBeenCalledWith({ id: 'r1', voteScore: 1 });
    expect(update).toHaveBeenCalledWith({ id: 'r2', voteScore: 1 });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('continues to the next revision when one update errors', async () => {
    const update = vi
      .fn()
      .mockResolvedValueOnce({ data: null, errors: [{ message: 'gone' }] })
      .mockResolvedValueOnce({ data: { id: 'r2' } });
    const listVotes = vi.fn(() => Promise.resolve([{ value: 'UP', weight: 1 }]));
    const dataClient: RevisionScoreDataClient = { models: { TranscriptRevision: { update } } };
    __setDeps({ listVotes, dataClient });

    await handler(streamEvent(['r1', 'r2']), context, cb);

    expect(update).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalled();
  });

  it('no-ops on a batch with no revision keys', async () => {
    const update = vi.fn();
    const dataClient: RevisionScoreDataClient = { models: { TranscriptRevision: { update } } };
    __setDeps({ listVotes: vi.fn(() => Promise.resolve([])), dataClient });
    await handler(streamEvent([undefined]), context, cb);
    expect(update).not.toHaveBeenCalled();
  });
});
