import { describe, it, expect } from 'vitest';
import { meanWordConfidence } from './confidence';
import type { WordTimestamp } from '../_shared/timestamps';

function w(word: string, confidence?: number): WordTimestamp {
  const entry: WordTimestamp = { word, startMs: 0, endMs: 100 };
  if (confidence !== undefined) entry.confidence = confidence;
  return entry;
}

describe('meanWordConfidence', () => {
  it('returns the arithmetic mean of per-word confidences', () => {
    const r = meanWordConfidence([w('a', 0.9), w('b', 0.7), w('c', 0.8)]);
    expect(r).toBeCloseTo(0.8, 10);
  });

  it('ignores words without a confidence', () => {
    const r = meanWordConfidence([w('a', 0.6), w('b'), w('c', 0.8)]);
    expect(r).toBeCloseTo(0.7, 10);
  });

  it('returns null when no word carries a confidence', () => {
    expect(meanWordConfidence([w('a'), w('b')])).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(meanWordConfidence([])).toBeNull();
  });

  it('drops out-of-range / non-finite confidences', () => {
    const r = meanWordConfidence([w('a', 1.0), w('b', -0.1), w('c', 2), w('d', 0.5)]);
    // Only 1.0 and 0.5 are valid → mean 0.75.
    expect(r).toBeCloseTo(0.75, 10);
  });
});
