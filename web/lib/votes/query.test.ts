import { describe, it, expect } from 'vitest';
import { tallyFieldVotes, toDisplayFieldVote, type DisplayFieldVote } from './query';

function vote(partial: Partial<DisplayFieldVote>): DisplayFieldVote {
  return {
    fieldKey: 'm#TYPE#v',
    messageId: 'm',
    field: 'TYPE',
    value: 'SKYKING',
    voterId: 'v',
    weightAtVoteTime: 1,
    firstCastAt: null,
    lastCastAt: null,
    ...partial,
  };
}

describe('toDisplayFieldVote', () => {
  it('copies known fields when field enum is valid', () => {
    const r = toDisplayFieldVote({
      fieldKey: 'm1#SENDER#v1',
      messageId: 'm1',
      field: 'SENDER',
      value: 'MAINSAIL',
      voterId: 'v1',
      weightAtVoteTime: 1.5,
      firstCastAt: '2026-05-28T12:00:00Z',
      lastCastAt: '2026-05-28T12:00:00Z',
    });
    expect(r).not.toBeNull();
    expect(r?.field).toBe('SENDER');
    expect(r?.weightAtVoteTime).toBe(1.5);
  });

  it('returns null on invalid field enum', () => {
    expect(
      toDisplayFieldVote({
        fieldKey: 'm#WAT#v',
        messageId: 'm',
        field: 'WAT',
        value: 'x',
        voterId: 'v',
      }),
    ).toBeNull();
  });

  it('defaults missing weight to 1', () => {
    const r = toDisplayFieldVote({
      fieldKey: 'm#TYPE#v',
      messageId: 'm',
      field: 'TYPE',
      value: 'SKYKING',
      voterId: 'v',
    });
    expect(r?.weightAtVoteTime).toBe(1);
  });
});

describe('tallyFieldVotes', () => {
  it('groups by value, sums weights, sorts by weight desc', () => {
    const t = tallyFieldVotes([
      vote({ value: 'SKYKING', weightAtVoteTime: 2 }),
      vote({ value: 'SKYKING', weightAtVoteTime: 1 }),
      vote({ value: 'SKYBIRD', weightAtVoteTime: 4 }),
      vote({ value: 'ALLSTATIONS', weightAtVoteTime: 0.5 }),
    ]);
    expect(t.entries).toEqual([
      { value: 'SKYBIRD', weight: 4, voterCount: 1 },
      { value: 'SKYKING', weight: 3, voterCount: 2 },
      { value: 'ALLSTATIONS', weight: 0.5, voterCount: 1 },
    ]);
    expect(t.total).toBe(7.5);
  });

  it('returns zero totals on empty input', () => {
    expect(tallyFieldVotes([])).toEqual({ entries: [], total: 0 });
  });
});
