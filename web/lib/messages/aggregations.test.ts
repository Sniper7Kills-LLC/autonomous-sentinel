import { describe, it, expect } from 'vitest';
import { aggregateDailyCounts, aggregateValueHistogram } from './aggregations';
import type { DisplayMessage } from './types';

function msg(partial: Partial<DisplayMessage>): DisplayMessage {
  return {
    id: 'm',
    type: 'OTHER',
    broadcastTs: '',
    sender: null,
    receiver: null,
    body: null,
    confidence: null,
    flaggedForReview: false,
    publishedAt: null,
    characterCount: null,
    codewordCount: null,
    ...partial,
  };
}

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

describe('aggregateValueHistogram', () => {
  it('counts occurrences of each integer value', () => {
    expect(
      aggregateValueHistogram(
        [msg({ characterCount: 30 }), msg({ characterCount: 28 }), msg({ characterCount: 30 })],
        'characterCount',
      ),
    ).toEqual([
      { value: 28, count: 1 },
      { value: 30, count: 2 },
    ]);
  });

  it('drops null/non-finite values', () => {
    expect(
      aggregateValueHistogram(
        [msg({ codewordCount: null }), msg({ codewordCount: 3 })],
        'codewordCount',
      ),
    ).toEqual([{ value: 3, count: 1 }]);
  });
});
