import { describe, it, expect } from 'vitest';
import {
  toCharFrequency,
  toCodewordFrequency,
  toRanking,
  toDailyTypeCounts,
  toDailyTotals,
  toStreaks,
  type AggregateRow,
} from './aggregates';

const rows = (...pairs: [string, number][]): AggregateRow[] =>
  pairs.map(([dimension, count]) => ({ dimension, count }));

describe('toCharFrequency (#780)', () => {
  it('maps + sorts by count desc, char asc, dropping zero/negative', () => {
    const out = toCharFrequency(rows(['A', 3], ['B', 3], ['C', 5], ['D', 0], ['E', -1]));
    expect(out).toEqual([
      { char: 'C', count: 5 },
      { char: 'A', count: 3 },
      { char: 'B', count: 3 },
    ]);
  });
});

describe('toCodewordFrequency (#780)', () => {
  it('maps + sorts', () => {
    const out = toCodewordFrequency(rows(['FOXTROT', 2], ['WHISKEY', 9]));
    expect(out[0]).toEqual({ codeword: 'WHISKEY', count: 9 });
  });
});

describe('toRanking (callsign usage / preamble) (#780)', () => {
  it('ranks by count then label', () => {
    const out = toRanking(rows(['MAINSAIL', 4], ['ANDREWS', 4], ['SKYKING', 10]));
    expect(out.map((r) => r.label)).toEqual(['SKYKING', 'ANDREWS', 'MAINSAIL']);
  });
});

describe('toDailyTypeCounts (#780)', () => {
  it('parses YYYY-MM-DD#TYPE into a per-day per-type series', () => {
    const { dates, types } = toDailyTypeCounts(
      rows(['2026-06-06#SKYKING', 2], ['2026-06-06#ALLSTATIONS', 1], ['2026-06-07#SKYKING', 3]),
    );
    expect(types).toEqual(['ALLSTATIONS', 'SKYKING']);
    expect(dates).toEqual([
      { date: '2026-06-06', total: 3, ALLSTATIONS: 1, SKYKING: 2 },
      { date: '2026-06-07', total: 3, ALLSTATIONS: 0, SKYKING: 3 },
    ]);
  });

  it('ignores malformed dimensions', () => {
    const { dates } = toDailyTypeCounts(rows(['no-hash', 5], ['2026-06-06#', 2], ['#SKYKING', 1]));
    expect(dates).toEqual([]);
  });
});

describe('toDailyTotals (#780)', () => {
  it('sums all types per day', () => {
    const out = toDailyTotals(
      rows(['2026-06-06#SKYKING', 2], ['2026-06-06#OTHER', 1], ['2026-06-07#SKYKING', 4]),
    );
    expect(out).toEqual([
      { date: '2026-06-06', count: 3 },
      { date: '2026-06-07', count: 4 },
    ]);
  });
});

describe('toStreaks (#780)', () => {
  it('computes current + longest consecutive-day runs per type', () => {
    // SKYKING active 06,07,08 (run 3) then gap then 10,11 (run 2, current).
    const out = toStreaks(
      rows(
        ['2026-06-06#SKYKING', 1],
        ['2026-06-07#SKYKING', 1],
        ['2026-06-08#SKYKING', 1],
        ['2026-06-10#SKYKING', 1],
        ['2026-06-11#SKYKING', 1],
      ),
    );
    expect(out).toEqual([{ type: 'SKYKING', current: 2, longest: 3, lastDate: '2026-06-11' }]);
  });

  it('a single isolated day is current=longest=1', () => {
    const out = toStreaks(rows(['2026-06-06#OTHER', 5]));
    expect(out[0]).toEqual({ type: 'OTHER', current: 1, longest: 1, lastDate: '2026-06-06' });
  });

  it('sorts by current desc', () => {
    const out = toStreaks(rows(['2026-06-06#A', 1], ['2026-06-06#B', 1], ['2026-06-07#B', 1]));
    expect(out.map((s) => s.type)).toEqual(['B', 'A']);
  });
});
