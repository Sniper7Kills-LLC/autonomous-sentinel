import { describe, it, expect } from 'vitest';
import {
  VOCAB_HASH_LENGTH,
  VOCAB_NAME_PREFIX,
  canonicaliseCallsigns,
  computeVocabHash,
  vocabChanged,
} from './vocab';

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

  it('exposes the canonicalised list ready to pass to Transcribe Phrases', () => {
    const h = computeVocabHash(['  hello  ', 'WORLD', 'hello']);
    expect(h.canonicalised).toEqual(['HELLO', 'WORLD']);
  });

  it('produces a stable hash for an empty dictionary (sentinel)', () => {
    // Two empty inputs must collide; downstream caller decides
    // whether to skip the Transcribe CreateVocabulary call when
    // canonicalised.length === 0.
    expect(computeVocabHash([]).full).toBe(computeVocabHash([]).full);
    expect(computeVocabHash([]).canonicalised).toEqual([]);
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
