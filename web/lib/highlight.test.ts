import { describe, it, expect } from 'vitest';
import { splitHighlight } from './highlight';

describe('splitHighlight', () => {
  it('returns the whole string as a single non-match segment when q is empty', () => {
    expect(splitHighlight('hello world', '')).toEqual([{ text: 'hello world', match: false }]);
  });

  it('returns the whole string when q is whitespace-only', () => {
    expect(splitHighlight('hello world', '   ')).toEqual([{ text: 'hello world', match: false }]);
  });

  it('returns the whole string when q is not found', () => {
    expect(splitHighlight('hello world', 'zzz')).toEqual([{ text: 'hello world', match: false }]);
  });

  it('splits around a single match', () => {
    expect(splitHighlight('hello world', 'world')).toEqual([
      { text: 'hello ', match: false },
      { text: 'world', match: true },
    ]);
  });

  it('matches case-insensitively but preserves original casing', () => {
    expect(splitHighlight('Hello WORLD', 'world')).toEqual([
      { text: 'Hello ', match: false },
      { text: 'WORLD', match: true },
    ]);
  });

  it('splits around multiple matches', () => {
    expect(splitHighlight('ab ab ab', 'ab')).toEqual([
      { text: 'ab', match: true },
      { text: ' ', match: false },
      { text: 'ab', match: true },
      { text: ' ', match: false },
      { text: 'ab', match: true },
    ]);
  });

  it('escapes regex metacharacters in q (no injection / no throw)', () => {
    // `.*` must match the literal substring, not "any chars".
    expect(splitHighlight('a.*b and axb', '.*')).toEqual([
      { text: 'a', match: false },
      { text: '.*', match: true },
      { text: 'b and axb', match: false },
    ]);
  });

  it('does not throw on unbalanced regex chars in q', () => {
    expect(() => splitHighlight('value (foo', '(foo')).not.toThrow();
    expect(splitHighlight('value (foo', '(foo')).toEqual([
      { text: 'value ', match: false },
      { text: '(foo', match: true },
    ]);
  });

  it('handles an empty input string', () => {
    expect(splitHighlight('', 'x')).toEqual([{ text: '', match: false }]);
  });
});
