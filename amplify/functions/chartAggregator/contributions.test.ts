import { describe, it, expect } from 'vitest';
import {
  isStatEligible,
  messageContributions,
  diffOps,
  accumulate,
  aggregateId,
  METRICS,
  type StatMessage,
  type CounterOp,
} from './contributions';

/** Build an eligible StatMessage with sensible defaults. */
function msg(overrides: Partial<StatMessage> = {}): StatMessage {
  return {
    type: 'OTHER',
    body: 'AB12',
    sender: null,
    receiver: null,
    broadcastTs: '2026-06-06T12:30:00.000Z',
    deletedAt: null,
    flaggedForReview: false,
    publishedAt: '2026-06-06T12:31:00.000Z',
    ...overrides,
  };
}

/** Find the delta for a (metric, dimension) in an op list (0 if absent). */
function deltaOf(ops: CounterOp[], metric: string, dimension: string): number {
  return ops
    .filter((o) => o.metric === metric && o.dimension === dimension)
    .reduce((a, o) => a + o.delta, 0);
}

describe('isStatEligible (#780)', () => {
  it('counts a published, non-deleted, non-flagged message', () => {
    expect(isStatEligible(msg())).toBe(true);
  });
  it('excludes soft-deleted (#621)', () => {
    expect(isStatEligible(msg({ deletedAt: '2026-06-06T13:00:00Z' }))).toBe(false);
  });
  it('excludes flagged-for-review', () => {
    expect(isStatEligible(msg({ flaggedForReview: true }))).toBe(false);
  });
  it('excludes unpublished (queued) messages', () => {
    expect(isStatEligible(msg({ publishedAt: null }))).toBe(false);
  });
  it('excludes null / undefined', () => {
    expect(isStatEligible(null)).toBe(false);
    expect(isStatEligible(undefined)).toBe(false);
  });
});

describe('messageContributions — daily count (#780)', () => {
  it('emits one per-type-per-day counter keyed by UTC day', () => {
    const ops = messageContributions(msg({ type: 'SKYKING', broadcastTs: '2026-06-06T23:59:00Z' }));
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-06#SKYKING')).toBe(1);
  });
  it('uses the UTC calendar day (not local)', () => {
    // 00:30Z is still 2026-06-07 in UTC regardless of runner TZ.
    const ops = messageContributions(msg({ type: 'OTHER', broadcastTs: '2026-06-07T00:30:00Z' }));
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-07#OTHER')).toBe(1);
  });
});

describe('messageContributions — ALLSTATIONS character frequency (#780)', () => {
  it('tallies each A-Z0-9 occurrence in the body', () => {
    const ops = messageContributions(msg({ type: 'ALLSTATIONS', body: 'AA1 B' }));
    expect(deltaOf(ops, METRICS.CHAR_FREQ_ALLSTATIONS, 'A')).toBe(2);
    expect(deltaOf(ops, METRICS.CHAR_FREQ_ALLSTATIONS, '1')).toBe(1);
    expect(deltaOf(ops, METRICS.CHAR_FREQ_ALLSTATIONS, 'B')).toBe(1);
  });
  it('does NOT emit char frequency for non-ALLSTATIONS types', () => {
    const ops = messageContributions(msg({ type: 'SKYKING', body: 'AAA' }));
    expect(deltaOf(ops, METRICS.CHAR_FREQ_ALLSTATIONS, 'A')).toBe(0);
  });
});

describe('messageContributions — SKYKING codewords (#780)', () => {
  it('tallies 3+ char alnum tokens, counting repeats', () => {
    const ops = messageContributions(msg({ type: 'SKYKING', body: 'FOXTROT FOXTROT AB' }));
    // "FOXTROT" twice; "AB" too short → skipped.
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(2);
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'AB')).toBe(0);
  });
  it('does NOT emit codewords for non-SKYKING types', () => {
    const ops = messageContributions(msg({ type: 'ALLSTATIONS', body: 'FOXTROT' }));
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(0);
  });
});

describe('messageContributions — callsign usage (#780)', () => {
  it('counts normalized sender + receiver', () => {
    const ops = messageContributions(msg({ sender: 'mainsail', receiver: 'Skyking' }));
    expect(deltaOf(ops, METRICS.CALLSIGN_USAGE, 'MAINSAIL')).toBe(1);
    expect(deltaOf(ops, METRICS.CALLSIGN_USAGE, 'SKYKING')).toBe(1);
  });
  it('counts a callsign twice when it is both sender and receiver', () => {
    const ops = messageContributions(msg({ sender: 'ANDREWS', receiver: 'ANDREWS' }));
    expect(deltaOf(ops, METRICS.CALLSIGN_USAGE, 'ANDREWS')).toBe(2);
  });
  it('skips ALL STATIONS and empty', () => {
    const ops = messageContributions(msg({ sender: 'ALL STATIONS', receiver: '' }));
    expect(ops.filter((o) => o.metric === METRICS.CALLSIGN_USAGE)).toHaveLength(0);
  });
});

describe('messageContributions — preamble first 2 chars (#780)', () => {
  it('uses the leading two alphanumerics (ignoring punctuation/space)', () => {
    const ops = messageContributions(msg({ body: '  7B-XYZ' }));
    expect(deltaOf(ops, METRICS.PREAMBLE_FIRST2, '7B')).toBe(1);
  });
  it('emits nothing when fewer than 2 alphanumerics', () => {
    const ops = messageContributions(msg({ body: 'A' }));
    expect(ops.filter((o) => o.metric === METRICS.PREAMBLE_FIRST2)).toHaveLength(0);
  });
});

describe('diffOps — write transitions (#780)', () => {
  it('create (no before) adds the after contributions', () => {
    const ops = diffOps(null, msg({ type: 'SKYKING', body: 'FOXTROT', sender: 'MAINSAIL' }));
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-06#SKYKING')).toBe(1);
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(1);
    expect(deltaOf(ops, METRICS.CALLSIGN_USAGE, 'MAINSAIL')).toBe(1);
  });

  it('soft-delete subtracts the prior contributions', () => {
    const before = msg({ type: 'SKYKING', body: 'FOXTROT' });
    const after = { ...before, deletedAt: '2026-06-06T14:00:00Z' };
    const ops = diffOps(before, after);
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-06#SKYKING')).toBe(-1);
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(-1);
  });

  it('publish (flagged→eligible) adds the contributions', () => {
    const before = msg({ flaggedForReview: true });
    const after = msg({ flaggedForReview: false });
    const ops = diffOps(before, after);
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-06#OTHER')).toBe(1);
  });

  it('restore (deleted→eligible) re-adds the contributions', () => {
    const before = msg({ deletedAt: '2026-06-06T14:00:00Z' });
    const after = msg({ deletedAt: null });
    const ops = diffOps(before, after);
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-06#OTHER')).toBe(1);
  });

  it('content edit nets to only the changed dimensions', () => {
    const before = msg({ type: 'SKYKING', body: 'FOXTROT' });
    const after = msg({ type: 'SKYKING', body: 'WHISKEY' });
    const ops = diffOps(before, after);
    // Daily count for the (unchanged) day#type cancels out entirely.
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-06#SKYKING')).toBe(0);
    expect(ops.find((o) => o.metric === METRICS.DAILY_COUNT)).toBeUndefined();
    // Codewords swap.
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(-1);
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'WHISKEY')).toBe(1);
  });

  it('no-op when both images are ineligible', () => {
    const before = msg({ flaggedForReview: true });
    const after = msg({ flaggedForReview: true, body: 'CHANGED' });
    expect(diffOps(before, after)).toEqual([]);
  });
});

describe('accumulate — backfill absolute counts (#780)', () => {
  it('sums eligible messages and skips ineligible ones', () => {
    const corpus: StatMessage[] = [
      msg({ type: 'SKYKING', body: 'FOXTROT', broadcastTs: '2026-06-06T01:00:00Z' }),
      msg({ type: 'SKYKING', body: 'FOXTROT', broadcastTs: '2026-06-06T02:00:00Z' }),
      msg({ type: 'SKYKING', body: 'FOXTROT', deletedAt: '2026-06-06T03:00:00Z' }), // excluded
    ];
    const totals = accumulate(corpus);
    expect(totals.get(aggregateId(METRICS.CODEWORD_SKYKING, 'FOXTROT'))?.count).toBe(2);
    expect(totals.get(aggregateId(METRICS.DAILY_COUNT, '2026-06-06#SKYKING'))?.count).toBe(2);
  });

  it('aggregateId composes metric + dimension', () => {
    expect(aggregateId('daily-count', '2026-06-06#SKYKING')).toBe('daily-count#2026-06-06#SKYKING');
  });
});
