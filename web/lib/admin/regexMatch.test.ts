import { describe, it, expect } from 'vitest';
import { testPattern } from './regexMatch';

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
});
