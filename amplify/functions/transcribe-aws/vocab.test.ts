import { describe, it, expect } from 'vitest';
import {
  BASE_VOCAB,
  VOCAB_HASH_LENGTH,
  VOCAB_NAME_PREFIX,
  canonicaliseCallsigns,
  computeVocabHash,
  unionWithBaseVocab,
  vocabChanged,
} from './vocab';

/** The NATO phonetic alphabet — the highest-value base-vocab subset. */
const NATO_ALPHABET = [
  'ALFA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
  'GOLF',
  'HOTEL',
  'INDIA',
  'JULIETT',
  'KILO',
  'LIMA',
  'MIKE',
  'NOVEMBER',
  'OSCAR',
  'PAPA',
  'QUEBEC',
  'ROMEO',
  'SIERRA',
  'TANGO',
  'UNIFORM',
  'VICTOR',
  'WHISKEY',
  'XRAY',
  'YANKEE',
  'ZULU',
];

/**
 * Behaviour tests for the Transcribe custom-vocab helpers (#56).
 *
 * Pins canonicalisation (trim / upper / dedupe / sort), hash
 * determinism + order-independence + change-detection, and
 * the vocab name shape.
 */

describe('canonicaliseCallsigns', () => {
  it('trims, uppercases, drops empty, dedupes, sorts', () => {
    expect(
      canonicaliseCallsigns([
        '  Skyking  ',
        'mainsail',
        'SKYKING',
        '',
        '   ',
        'alpha',
        'BRAVO',
        'alpha',
      ]),
    ).toEqual(['ALPHA', 'BRAVO', 'MAINSAIL', 'SKYKING']);
  });

  it('ignores non-string entries (null / undefined / number)', () => {
    expect(canonicaliseCallsigns(['X', null, undefined, 42 as unknown as string, 'Y'])).toEqual([
      'X',
      'Y',
    ]);
  });

  it('returns [] on an empty / fully-junk input', () => {
    expect(canonicaliseCallsigns([])).toEqual([]);
    expect(canonicaliseCallsigns(['', '   ', null, undefined])).toEqual([]);
  });
});

describe('computeVocabHash', () => {
  it('produces a deterministic 64-char hex digest', () => {
    const a = computeVocabHash(['SKYKING', 'MAINSAIL']);
    const b = computeVocabHash(['SKYKING', 'MAINSAIL']);
    expect(a.full).toBe(b.full);
    expect(a.full).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-independent (re-arranging the dictionary does not change the hash)', () => {
    const a = computeVocabHash(['SKYKING', 'MAINSAIL', 'BACKBONE']);
    const b = computeVocabHash(['BACKBONE', 'mainsail', 'skyking']);
    expect(a.full).toBe(b.full);
  });

  it('differs across distinct dictionaries', () => {
    expect(computeVocabHash(['A']).full).not.toBe(computeVocabHash(['B']).full);
    expect(computeVocabHash(['A']).full).not.toBe(computeVocabHash(['A', 'B']).full);
  });

  it('embeds the short hash into the vocab name with the project prefix', () => {
    const h = computeVocabHash(['SKYKING']);
    expect(h.vocabName).toBe(`${VOCAB_NAME_PREFIX}${h.short}`);
    expect(h.short.length).toBe(VOCAB_HASH_LENGTH);
    expect(h.vocabName).toMatch(/^eam-callsigns-[0-9a-f]{12}$/);
  });

  it('exposes the canonicalised term list (base ∪ callsigns) ready for Transcribe Phrases', () => {
    const h = computeVocabHash(['  hello  ', 'WORLD', 'hello']);
    // The dynamic callsigns survive, deduped + uppercased…
    expect(h.canonicalised).toContain('HELLO');
    expect(h.canonicalised).toContain('WORLD');
    // …and the static base is unioned in.
    expect(h.canonicalised).toContain('FOXTROT');
    expect(h.canonicalised).toContain('SKYKING');
    // Sorted + deduped.
    expect(h.canonicalised).toEqual([...new Set(h.canonicalised)].sort());
  });

  it('unions the static BASE_VOCAB into the term list even for an empty dictionary', () => {
    const h = computeVocabHash([]);
    expect(h.full).toBe(computeVocabHash([]).full); // deterministic
    expect(h.canonicalised.length).toBeGreaterThan(0); // base alone is non-empty
    for (const term of BASE_VOCAB) {
      expect(h.canonicalised).toContain(term);
    }
  });
});

describe('BASE_VOCAB union', () => {
  it('includes the full NATO phonetic alphabet in the computed vocab term list', () => {
    const terms = computeVocabHash(['SKYKING']).canonicalised;
    for (const letter of NATO_ALPHABET) {
      expect(terms).toContain(letter);
    }
  });

  it('includes military digit words and EAM prowords (STANDBY + hyphenated MORE-TO-FOLLOW)', () => {
    const terms = unionWithBaseVocab([]);
    for (const digit of ['ZERO', 'TREE', 'FOWER', 'FIFE', 'NINER']) {
      expect(terms).toContain(digit);
    }
    expect(terms).toContain('STANDBY');
    expect(terms).toContain('MORE-TO-FOLLOW');
  });

  it('every BASE_VOCAB entry is already canonical (uppercase, trimmed, non-empty)', () => {
    for (const term of BASE_VOCAB) {
      expect(term).toBe(term.trim().toUpperCase());
      expect(term.length).toBeGreaterThan(0);
    }
  });

  it('a callsign-only change still rolls the hash (union changes)', () => {
    expect(computeVocabHash([]).full).not.toBe(computeVocabHash(['BACKBONE']).full);
  });
});

describe('vocabChanged', () => {
  it('returns true when no previous hash is recorded', () => {
    const next = computeVocabHash(['X']);
    expect(vocabChanged(null, next)).toBe(true);
    expect(vocabChanged(undefined, next)).toBe(true);
    expect(vocabChanged('', next)).toBe(true);
  });

  it('returns false when previous full hash matches next', () => {
    const next = computeVocabHash(['X']);
    expect(vocabChanged(next.full, next)).toBe(false);
  });

  it('returns true on any divergence', () => {
    const prev = computeVocabHash(['X']);
    const next = computeVocabHash(['X', 'Y']);
    expect(vocabChanged(prev.full, next)).toBe(true);
  });

  it('compares on full digest, not short (truncation collision safety)', () => {
    // Construct a fake previous full hash whose short prefix
    // matches the next short — change-detection must still fire.
    const next = computeVocabHash(['X']);
    const fakePrev = `${next.short}${'0'.repeat(64 - VOCAB_HASH_LENGTH)}`;
    expect(fakePrev.slice(0, VOCAB_HASH_LENGTH)).toBe(next.short);
    expect(fakePrev).not.toBe(next.full);
    expect(vocabChanged(fakePrev, next)).toBe(true);
  });
});
