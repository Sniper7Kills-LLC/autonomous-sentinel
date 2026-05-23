import { describe, it, expect } from 'vitest';
import {
  normalizeAmazonTranscribe,
  normalizeOpenAIVerbose,
  normalizeWhisperCpp,
  offsetWords,
  stitchChunks,
  type WordTimestamp,
} from './timestamps';

/**
 * Behaviour tests for the word-timestamp normalisers (#61).
 *
 * Pins per-backend native-shape → canonical `WordTimestamp[]`
 * conversion, the units conversion (cs / s / s-as-string → ms),
 * meta-token filtering, malformed-row tolerance, and the
 * chunk-offset + stitcher math.
 */

describe('normalizeOpenAIVerbose', () => {
  it('maps verbose_json words to WordTimestamp[] with seconds → ms', () => {
    const out = normalizeOpenAIVerbose({
      words: [
        { word: 'SKYKING', start: 0.0, end: 0.5 },
        { word: 'DELTA', start: 0.6, end: 1.1 },
      ],
    });
    expect(out).toEqual([
      { word: 'SKYKING', startMs: 0, endMs: 500 },
      { word: 'DELTA', startMs: 600, endMs: 1100 },
    ]);
  });

  it('returns [] when words is missing / not an array', () => {
    expect(normalizeOpenAIVerbose(null)).toEqual([]);
    expect(normalizeOpenAIVerbose(undefined)).toEqual([]);
    expect(normalizeOpenAIVerbose({})).toEqual([]);
    expect(normalizeOpenAIVerbose({ words: 'nope' as unknown as never })).toEqual([]);
  });

  it('skips malformed entries (missing word, non-numeric times, negative, reversed)', () => {
    const malformed = [
      { word: 'OK', start: 0.0, end: 0.5 },
      { word: '', start: 0.6, end: 1.1 }, // empty word still kept (valid string)
      { start: 0.0, end: 0.5 }, // missing word
      { word: 'NEG', start: -1, end: 0 },
      { word: 'REV', start: 1.0, end: 0.5 },
      { word: 'NAN', start: Number.NaN, end: 0.5 },
    ] as unknown as { word: string; start: number; end: number }[];
    const out = normalizeOpenAIVerbose({ words: malformed });
    expect(out.map((w) => w.word)).toEqual(['OK', '']);
  });
});

describe('normalizeWhisperCpp', () => {
  it('converts centiseconds to ms + carries confidence + filters meta tokens', () => {
    const out = normalizeWhisperCpp({
      transcription: [
        {
          tokens: [
            { text: '[_BEG_]', t0: 0, t1: 0 },
            { text: 'SKYKING', t0: 100, t1: 150, p: 0.95 },
            { text: '[_TT_24]', t0: 150, t1: 160 },
            { text: 'DELTA', t0: 160, t1: 210, p: 0.88 },
          ],
        },
      ],
    });
    expect(out).toEqual([
      { word: 'SKYKING', startMs: 1000, endMs: 1500, confidence: 0.95 },
      { word: 'DELTA', startMs: 1600, endMs: 2100, confidence: 0.88 },
    ]);
  });

  it('flattens multiple segments in order', () => {
    const out = normalizeWhisperCpp({
      transcription: [
        { tokens: [{ text: 'A', t0: 0, t1: 50 }] },
        { tokens: [{ text: 'B', t0: 100, t1: 150 }] },
      ],
    });
    expect(out.map((w) => w.word)).toEqual(['A', 'B']);
  });

  it('returns [] on missing transcription / segment.tokens', () => {
    expect(normalizeWhisperCpp(null)).toEqual([]);
    expect(normalizeWhisperCpp({})).toEqual([]);
    expect(normalizeWhisperCpp({ transcription: [{}] })).toEqual([]);
  });

  it('omits confidence when p is missing / NaN', () => {
    const out = normalizeWhisperCpp({
      transcription: [{ tokens: [{ text: 'X', t0: 0, t1: 50 }] }],
    });
    expect(out[0]).toEqual({ word: 'X', startMs: 0, endMs: 500 });
    expect(out[0]).not.toHaveProperty('confidence');
  });
});

describe('normalizeAmazonTranscribe', () => {
  it('converts string seconds + string confidence + drops punctuation', () => {
    const out = normalizeAmazonTranscribe({
      results: {
        items: [
          {
            type: 'pronunciation',
            start_time: '0.0',
            end_time: '0.5',
            alternatives: [{ content: 'SKYKING', confidence: '0.97' }],
          },
          {
            type: 'punctuation',
            alternatives: [{ content: '.' }],
          },
          {
            type: 'pronunciation',
            start_time: '0.6',
            end_time: '1.1',
            alternatives: [{ content: 'DELTA', confidence: '0.92' }],
          },
        ],
      },
    });
    expect(out).toEqual([
      { word: 'SKYKING', startMs: 0, endMs: 500, confidence: 0.97 },
      { word: 'DELTA', startMs: 600, endMs: 1100, confidence: 0.92 },
    ]);
  });

  it('skips rows with no alternative content or malformed times', () => {
    const out = normalizeAmazonTranscribe({
      results: {
        items: [
          {
            type: 'pronunciation',
            start_time: '0.0',
            end_time: '0.5',
            alternatives: [],
          },
          {
            type: 'pronunciation',
            start_time: 'not-a-number',
            end_time: '0.5',
            alternatives: [{ content: 'X' }],
          },
          {
            type: 'pronunciation',
            start_time: '0.0',
            end_time: '0.5',
            alternatives: [{ content: 'OK' }],
          },
        ],
      },
    });
    expect(out.map((w) => w.word)).toEqual(['OK']);
  });

  it('returns [] when results.items is missing / not an array', () => {
    expect(normalizeAmazonTranscribe(null)).toEqual([]);
    expect(normalizeAmazonTranscribe({})).toEqual([]);
    expect(normalizeAmazonTranscribe({ results: {} })).toEqual([]);
  });

  it('omits confidence when not parseable', () => {
    const out = normalizeAmazonTranscribe({
      results: {
        items: [
          {
            type: 'pronunciation',
            start_time: '0.0',
            end_time: '0.5',
            alternatives: [{ content: 'X', confidence: 'not-a-number' }],
          },
        ],
      },
    });
    expect(out[0]).not.toHaveProperty('confidence');
  });
});

describe('offsetWords', () => {
  const sample: WordTimestamp[] = [
    { word: 'A', startMs: 100, endMs: 200 },
    { word: 'B', startMs: 300, endMs: 400, confidence: 0.9 },
  ];

  it('shifts each word by offsetMs without mutating the input', () => {
    const out = offsetWords(sample, 5000);
    expect(out).toEqual([
      { word: 'A', startMs: 5100, endMs: 5200 },
      { word: 'B', startMs: 5300, endMs: 5400, confidence: 0.9 },
    ]);
    expect(sample[0]?.startMs).toBe(100); // unchanged
  });

  it('returns a shallow copy when offsetMs is 0', () => {
    const out = offsetWords(sample, 0);
    expect(out).toEqual(sample);
    expect(out).not.toBe(sample);
  });

  it('throws on non-finite offsetMs', () => {
    expect(() => offsetWords(sample, Number.NaN)).toThrow(/finite/);
    expect(() => offsetWords(sample, Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe('stitchChunks', () => {
  it('concatenates chunks with cumulative offsets onto the global clock', () => {
    const out = stitchChunks([
      {
        startMs: 0,
        words: [
          { word: 'A', startMs: 0, endMs: 500 },
          { word: 'B', startMs: 600, endMs: 1100 },
        ],
      },
      {
        startMs: 300_000, // chunk 2 begins at 5min global
        words: [
          { word: 'C', startMs: 0, endMs: 400 },
          { word: 'D', startMs: 500, endMs: 900 },
        ],
      },
    ]);
    expect(out).toEqual([
      { word: 'A', startMs: 0, endMs: 500 },
      { word: 'B', startMs: 600, endMs: 1100 },
      { word: 'C', startMs: 300_000, endMs: 300_400 },
      { word: 'D', startMs: 300_500, endMs: 300_900 },
    ]);
  });

  it('returns [] on an empty chunks list', () => {
    expect(stitchChunks([])).toEqual([]);
  });
});
