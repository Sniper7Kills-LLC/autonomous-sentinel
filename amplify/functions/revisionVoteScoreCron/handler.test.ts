import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context, ScheduledEvent } from 'aws-lambda';
import {
  handler,
  sumVoteScore,
  accumulateVotes,
  __setDeps,
  __resetDeps,
  type VoteWeight,
} from './handler';

const event = {} as ScheduledEvent;
const context = {} as Context;
const cb = () => undefined;

describe('revisionVoteScoreCron — sumVoteScore (#653)', () => {
  it('sums UP as +weight, DOWN as -weight', () => {
    expect(
      sumVoteScore([
        { value: 'UP', weight: 2 },
        { value: 'UP', weight: 0.5 },
        { value: 'DOWN', weight: 1 },
      ]),
    ).toBe(1.5);
  });

  it('treats unknown values + non-finite weights as 0', () => {
    expect(
      sumVoteScore([
        { value: 'SIDEWAYS', weight: 9 },
        { value: 'UP', weight: Number.NaN },
        { value: 'DOWN', weight: 2 },
      ]),
    ).toBe(-2);
  });

  it('is 0 for no votes', () => {
    expect(sumVoteScore([])).toBe(0);
  });
});

describe('revisionVoteScoreCron — accumulateVotes (#653)', () => {
  it('groups votes by revisionId and skips keyless rows', () => {
    const into = new Map<string, VoteWeight[]>();
    accumulateVotes(
      [
        { revisionId: 'r1', value: 'UP', weightAtVoteTime: 2 },
        { revisionId: 'r1', value: 'DOWN', weightAtVoteTime: 1 },
        { revisionId: 'r2', value: 'UP', weightAtVoteTime: 1 },
        { value: 'UP', weightAtVoteTime: 1 }, // no revisionId → skipped
      ],
      into,
    );
    expect(into.get('r1')).toHaveLength(2);
    expect(into.get('r2')).toHaveLength(1);
    expect(into.has('')).toBe(false);
  });

  it('defaults a missing weight to 1', () => {
    const into = new Map<string, VoteWeight[]>();
    accumulateVotes([{ revisionId: 'r1', value: 'UP' }], into);
    expect(into.get('r1')?.[0]).toEqual({ value: 'UP', weight: 1 });
  });
});

describe('revisionVoteScoreCron — handler (#653)', () => {
  beforeEach(() => {
    __resetDeps();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('writes the recomputed score for each revision with votes', async () => {
    const writeScore = vi.fn().mockResolvedValue(undefined);
    __setDeps({
      scanAllVotes: () =>
        Promise.resolve(
          new Map<string, VoteWeight[]>([
            [
              'r1',
              [
                { value: 'UP', weight: 2 },
                { value: 'DOWN', weight: 1 },
              ],
            ],
            ['r2', [{ value: 'UP', weight: 3 }]],
          ]),
        ),
      writeScore,
      now: () => new Date('2026-06-02T20:00:00.000Z'),
    });

    const res = await handler(event, context, cb);

    expect(res).toEqual({ revisionsScored: 2 });
    expect(writeScore).toHaveBeenCalledWith('r1', 1, '2026-06-02T20:00:00.000Z');
    expect(writeScore).toHaveBeenCalledWith('r2', 3, '2026-06-02T20:00:00.000Z');
  });

  it('continues + counts only successes when one revision write fails', async () => {
    const writeScore = vi
      .fn()
      .mockRejectedValueOnce(new Error('revision deleted'))
      .mockResolvedValueOnce(undefined);
    __setDeps({
      scanAllVotes: () =>
        Promise.resolve(
          new Map<string, VoteWeight[]>([
            ['gone', [{ value: 'UP', weight: 1 }]],
            ['ok', [{ value: 'UP', weight: 1 }]],
          ]),
        ),
      writeScore,
      now: () => new Date('2026-06-02T20:00:00.000Z'),
    });

    const res = await handler(event, context, cb);
    expect(res).toEqual({ revisionsScored: 1 });
    expect(console.error).toHaveBeenCalled();
  });

  it('no-ops when there are no votes', async () => {
    const writeScore = vi.fn();
    __setDeps({ scanAllVotes: () => Promise.resolve(new Map()), writeScore });
    const res = await handler(event, context, cb);
    expect(res).toEqual({ revisionsScored: 0 });
    expect(writeScore).not.toHaveBeenCalled();
  });
});
