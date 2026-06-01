import { describe, it, expect } from 'vitest';
import { charFrequency, codewordFrequency, tokenizeCodewords } from './frequency';

describe('charFrequency', () => {
  it('tallies each alphanumeric character across bodies', () => {
    expect(charFrequency([{ body: 'ABA' }, { body: 'B1' }])).toEqual([
      { char: 'A', count: 2 },
      { char: 'B', count: 2 },
      { char: '1', count: 1 },
    ]);
  });

  it('is case-insensitive (folds lowercase to uppercase)', () => {
    expect(charFrequency([{ body: 'aA' }])).toEqual([{ char: 'A', count: 2 }]);
  });

  it('ignores whitespace and punctuation', () => {
    expect(charFrequency([{ body: 'A B-C.A' }])).toEqual([
      { char: 'A', count: 2 },
      { char: 'B', count: 1 },
      { char: 'C', count: 1 },
    ]);
  });

  it('drops null and empty bodies', () => {
    expect(charFrequency([{ body: null }, { body: '' }, { body: 'Z' }])).toEqual([
      { char: 'Z', count: 1 },
    ]);
  });

  it('sorts by count desc then char asc on ties', () => {
    // counts: 9 -> 3, A -> 2, B -> 2, 1 -> 1; A and B tie on 2 -> A first.
    expect(charFrequency([{ body: '999AABB1' }])).toEqual([
      { char: '9', count: 3 },
      { char: 'A', count: 2 },
      { char: 'B', count: 2 },
      { char: '1', count: 1 },
    ]);
  });

  it('returns empty array for an empty corpus', () => {
    expect(charFrequency([])).toEqual([]);
  });
});

describe('tokenizeCodewords', () => {
  it('extracts contiguous [A-Z0-9]{3,} groups, uppercased', () => {
    expect(tokenizeCodewords('FOXTROT alpha BR1')).toEqual(['FOXTROT', 'ALPHA', 'BR1']);
  });

  it('excludes groups shorter than 3 characters', () => {
    // AB / CD / X1 are 2 chars -> dropped; ABC / Y22 are 3 chars -> kept.
    expect(tokenizeCodewords('AB CD ABC X1 Y22')).toEqual(['ABC', 'Y22']);
  });

  it('splits on punctuation and whitespace boundaries', () => {
    expect(tokenizeCodewords('ABC-DEF.GHI/JKL')).toEqual(['ABC', 'DEF', 'GHI', 'JKL']);
  });

  it('handles mixed alphanumeric tokens', () => {
    expect(tokenizeCodewords('K1NG 4LPHA')).toEqual(['K1NG', '4LPHA']);
  });

  it('returns empty array for null, undefined, and empty bodies', () => {
    expect(tokenizeCodewords(null)).toEqual([]);
    expect(tokenizeCodewords(undefined)).toEqual([]);
    expect(tokenizeCodewords('')).toEqual([]);
    expect(tokenizeCodewords('-- .. ()')).toEqual([]);
  });
});

describe('codewordFrequency', () => {
  it('tallies each distinct codeword across bodies', () => {
    expect(codewordFrequency([{ body: 'ALPHA BRAVO' }, { body: 'ALPHA charlie' }])).toEqual([
      { codeword: 'ALPHA', count: 2 },
      { codeword: 'BRAVO', count: 1 },
      { codeword: 'CHARLIE', count: 1 },
    ]);
  });

  it('is case-insensitive', () => {
    expect(codewordFrequency([{ body: 'echo' }, { body: 'ECHO' }])).toEqual([
      { codeword: 'ECHO', count: 2 },
    ]);
  });

  it('ignores sub-3-char tokens and null bodies', () => {
    expect(codewordFrequency([{ body: 'XX YY ZULU' }, { body: null }])).toEqual([
      { codeword: 'ZULU', count: 1 },
    ]);
  });

  it('sorts by count desc then codeword asc', () => {
    expect(
      codewordFrequency([{ body: 'BRAVO ALPHA BRAVO ALPHA CHARLIE' }, { body: 'CHARLIE' }]),
    ).toEqual([
      { codeword: 'ALPHA', count: 2 },
      { codeword: 'BRAVO', count: 2 },
      { codeword: 'CHARLIE', count: 2 },
    ]);
  });

  it('returns empty array for an empty corpus', () => {
    expect(codewordFrequency([])).toEqual([]);
  });
});
