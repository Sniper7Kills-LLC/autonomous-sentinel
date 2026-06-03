import { describe, it, expect } from 'vitest';
import { toDisplayMessage } from './query';

describe('toDisplayMessage', () => {
  it('preserves canonical Message fields', () => {
    expect(
      toDisplayMessage({
        id: 'm1',
        type: 'SKYKING',
        broadcastTs: '2026-05-27T12:00:00Z',
        sender: 'MAINSAIL',
        receiver: 'ANCHOR',
        body: 'PT3 14 AB',
        confidence: 0.92,
        flaggedForReview: false,
        publishedAt: '2026-05-27T12:30:00Z',
      }),
    ).toEqual({
      id: 'm1',
      type: 'SKYKING',
      broadcastTs: '2026-05-27T12:00:00Z',
      sender: 'MAINSAIL',
      receiver: 'ANCHOR',
      body: 'PT3 14 AB',
      confidence: 0.92,
      flaggedForReview: false,
      publishedAt: '2026-05-27T12:30:00Z',
    });
  });

  it('coerces unknown type to OTHER', () => {
    const row = toDisplayMessage({
      id: 'm2',
      type: 'BOGUS',
      broadcastTs: '2026-05-27T12:00:00Z',
      sender: null,
      receiver: null,
      body: null,
      confidence: null,
      flaggedForReview: null,
      publishedAt: null,
    });
    expect(row.type).toBe('OTHER');
    expect(row.flaggedForReview).toBe(false);
  });

  it('normalises nullish numeric fields to null', () => {
    const row = toDisplayMessage({
      id: 'm3',
      type: 'BACKEND',
      broadcastTs: '2026-05-27T12:00:00Z',
      sender: null,
      receiver: null,
      body: null,
      confidence: undefined,
      flaggedForReview: undefined,
      publishedAt: undefined,
    });
    expect(row.confidence).toBeNull();
  });
});
