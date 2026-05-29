import { describe, it, expect } from 'vitest';
import { contentMatches, tokenSimilarity, dedupWindow, EXACT_MATCH_TYPES } from './dedup';

describe('dedup — tokenSimilarity', () => {
  it('is 1 for identical bodies and 1 for two empties', () => {
    expect(tokenSimilarity('alpha bravo', 'alpha bravo')).toBe(1);
    expect(tokenSimilarity('', '')).toBe(1);
  });
  it('is 0 when one side is empty', () => {
    expect(tokenSimilarity('alpha', '')).toBe(0);
  });
  it('reflects token overlap (Jaccard)', () => {
    // {a,b,c} vs {a,b,d}: inter=2, union=4 → 0.5
    expect(tokenSimilarity('a b c', 'a b d')).toBeCloseTo(0.5, 5);
  });
});

describe('dedup — contentMatches', () => {
  it('SKYKING/ALLSTATIONS require exact (case/space-insensitive) decoded equality', () => {
    expect(contentMatches('ALLSTATIONS', 'ACD', 'ACD')).toBe(true);
    expect(contentMatches('ALLSTATIONS', 'ACD', 'acd')).toBe(true);
    expect(contentMatches('ALLSTATIONS', 'ACD', 'ACE')).toBe(false);
    expect(contentMatches('SKYKING', '', '')).toBe(false); // empty never matches
  });

  it('non-decoding types match on similarity threshold (cross-SDR variance)', () => {
    const a = 'cape radio this is mainsail radio check over';
    const b = 'cape radio this is mainsail radio check over now'; // 1 extra token
    expect(contentMatches('RADIOCHECK', a, b, 0.85)).toBe(true);
    expect(contentMatches('OTHER', 'totally different one', 'nothing alike here two', 0.85)).toBe(
      false,
    );
  });

  it('decoding types are the exact-match set', () => {
    expect([...EXACT_MATCH_TYPES].sort()).toEqual(['ALLSTATIONS', 'SKYKING']);
  });
});

describe('dedup — dedupWindow', () => {
  it('brackets the broadcast time by ± the window', () => {
    const w = dedupWindow('2026-05-29T18:00:00.000Z', 120_000);
    expect(w.start).toBe('2026-05-29T17:58:00.000Z');
    expect(w.end).toBe('2026-05-29T18:02:00.000Z');
  });
});
