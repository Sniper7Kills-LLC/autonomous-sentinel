import { describe, it, expect } from 'vitest';
import { aggregateDailyCounts } from './aggregations';

describe('aggregateDailyCounts', () => {
  it('groups timestamps to UTC date buckets', () => {
    expect(
      aggregateDailyCounts([
        { broadcastTs: '2026-05-27T01:00:00Z' },
        { broadcastTs: '2026-05-27T23:59:00Z' },
        { broadcastTs: '2026-05-28T00:00:00Z' },
      ]),
    ).toEqual([
      { date: '2026-05-27', count: 2 },
      { date: '2026-05-28', count: 1 },
    ]);
  });

  it('drops malformed timestamps silently', () => {
    expect(
      aggregateDailyCounts([{ broadcastTs: 'nope' }, { broadcastTs: '2026-05-27T00:00:00Z' }]),
    ).toEqual([{ date: '2026-05-27', count: 1 }]);
  });
});
