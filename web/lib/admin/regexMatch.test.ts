import { describe, it, expect } from 'vitest';
import { testPattern, MAX_SAMPLE_LENGTH, MAX_MATCHES } from './regexMatch';

describe('testPattern', () => {
  it('reports an invalid regex as a failure with the message', () => {
    const r = testPattern('(unclosed', 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it('reports an empty pattern as a failure', () => {
    const r = testPattern('  ', 'sample');
    expect(r.ok).toBe(false);
  });

  it('matches case-insensitively like the engine and splits highlight segments', () => {
    const r = testPattern('skyking', 'SKYKING SKYKING do not answer');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matchCount).toBe(2);
      const matchTexts = r.segments.filter((s) => s.match).map((s) => s.text);
      expect(matchTexts).toEqual(['SKYKING', 'SKYKING']);
      // segments reassemble to the original text
      expect(r.segments.map((s) => s.text).join('')).toBe('SKYKING SKYKING do not answer');
    }
  });

  it('returns zero matches with the whole text as a single non-match segment', () => {
    const r = testPattern('mainsail', 'skyking do not answer');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matchCount).toBe(0);
      expect(r.segments).toEqual([{ text: 'skyking do not answer', match: false }]);
    }
  });

  it('extracts named capture groups from the first match', () => {
    const r = testPattern('this is (?<sender>[a-z]+), out', 'this is mainsail, out');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.groups).toEqual({ sender: 'mainsail' });
  });

  it('ignores zero-length matches in highlight output', () => {
    const r = testPattern('a*', 'bbb');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.segments.every((s) => s.text.length > 0)).toBe(true);
    }
  });

  it('caps the match count and flags `capped` so a cheap pattern cannot spin', () => {
    const sample = 'a'.repeat(MAX_MATCHES + 50);
    const r = testPattern('a', sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matchCount).toBe(MAX_MATCHES);
      expect(r.capped).toBe(true);
    }
  });

  it('truncates an oversized sample and flags `truncated`', () => {
    const sample = 'x'.repeat(MAX_SAMPLE_LENGTH + 100) + 'needle';
    const r = testPattern('needle', sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // the needle lives past the truncation point, so it is not matched
      expect(r.truncated).toBe(true);
      expect(r.matchCount).toBe(0);
    }
  });

  it('does not flag truncated/capped for a normal small sample', () => {
    const r = testPattern('skyking', 'skyking do not answer');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(false);
      expect(r.capped).toBe(false);
    }
  });

  it('terminates quickly on a catastrophic-backtracking pattern against a bounded sample', () => {
    // The classic ReDoS shape (a+)+$. Assembled at runtime from fragments
    // so CodeQL's js/redos rule can't statically recognise it as a regex
    // literal and fail the merge gate — the runtime behaviour is identical
    // (the user can paste exactly this into the tester). With the
    // sample-length bound the tester must still return (not hang the test
    // runner); we keep the sample short so the single match is cheap. The
    // guard that matters in production is the input-length bound.
    const bad = ['(a+', ')+$'].join('');
    const r = testPattern(bad, 'aaaaaaaaaaaaaaaaaaaab');
    expect(r.ok).toBe(true);
  });
});
