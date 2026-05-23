import { describe, it, expect } from 'vitest';
import type { WordTimestamp } from './timestamps';
import {
  DEFAULT_TARGET_CHUNK_MS,
  chunkKeyFor,
  computeChunkBoundaries,
  nearestSilence,
  stitchTranscripts,
  type VadSegment,
} from './chunk';

/**
 * Behaviour tests for the chunk-boundary math + stitcher (#59).
 *
 * Pins the bypass path (≤ target → single chunk), the silence-
 * aware split path, the no-VAD fallback, the S3 key format,
 * and the stitcher offset math.
 */

const FIVE_MIN = DEFAULT_TARGET_CHUNK_MS;
const TEN_MIN = FIVE_MIN * 2;
const TWELVE_MIN = 12 * 60 * 1000;

describe('computeChunkBoundaries — bypass', () => {
  it('returns a single chunk when duration <= target', () => {
    expect(computeChunkBoundaries(FIVE_MIN)).toEqual([{ startMs: 0, endMs: FIVE_MIN, index: 0 }]);
    expect(computeChunkBoundaries(60_000)).toEqual([{ startMs: 0, endMs: 60_000, index: 0 }]);
  });

  it('throws on non-finite / non-positive durationMs', () => {
    expect(() => computeChunkBoundaries(0)).toThrow(/positive finite/);
    expect(() => computeChunkBoundaries(-1)).toThrow(/positive finite/);
    expect(() => computeChunkBoundaries(Number.NaN)).toThrow(/positive finite/);
    expect(() => computeChunkBoundaries(Number.POSITIVE_INFINITY)).toThrow(/positive finite/);
  });

  it('throws on non-positive targetChunkMs', () => {
    expect(() => computeChunkBoundaries(FIVE_MIN * 2, { targetChunkMs: 0 })).toThrow(
      /positive finite/,
    );
  });
});

describe('computeChunkBoundaries — silence-aware split', () => {
  it('splits at the silence boundary nearest each target', () => {
    // 12-min recording. Silence segments at ~5min ±10s and ~10min ±15s.
    const vad: VadSegment[] = [
      { startMs: 0, endMs: 290_000, isSpeech: true },
      { startMs: 290_000, endMs: 300_000, isSpeech: false }, // midpoint 295_000
      { startMs: 300_000, endMs: 595_000, isSpeech: true },
      { startMs: 595_000, endMs: 605_000, isSpeech: false }, // midpoint 600_000
      { startMs: 605_000, endMs: TWELVE_MIN, isSpeech: true },
    ];
    const out = computeChunkBoundaries(TWELVE_MIN, { vad });
    expect(out).toEqual([
      { startMs: 0, endMs: 295_000, index: 0 },
      { startMs: 295_000, endMs: 600_000, index: 1 },
      { startMs: 600_000, endMs: TWELVE_MIN, index: 2 },
    ]);
  });

  it('falls back to a hard target cut when no silence lands in the window', () => {
    // VAD provided but all silence is far from the target ms.
    const vad: VadSegment[] = [
      { startMs: 0, endMs: 1_000, isSpeech: false }, // midpoint 500ms — far from 5min
      { startMs: 1_000, endMs: TEN_MIN, isSpeech: true },
    ];
    const out = computeChunkBoundaries(TEN_MIN, { vad });
    expect(out).toEqual([
      { startMs: 0, endMs: FIVE_MIN, index: 0 },
      { startMs: FIVE_MIN, endMs: TEN_MIN, index: 1 },
    ]);
  });

  it('falls back to hard cuts when no VAD is supplied', () => {
    const out = computeChunkBoundaries(TWELVE_MIN);
    expect(out).toEqual([
      { startMs: 0, endMs: FIVE_MIN, index: 0 },
      { startMs: FIVE_MIN, endMs: TEN_MIN, index: 1 },
      { startMs: TEN_MIN, endMs: TWELVE_MIN, index: 2 },
    ]);
  });

  it('uses an override targetChunkMs', () => {
    const out = computeChunkBoundaries(180_000, { targetChunkMs: 60_000 });
    expect(out.map((c) => c.endMs)).toEqual([60_000, 120_000, 180_000]);
  });

  it('respects an override silenceSearchWindowMs', () => {
    // Silence midpoint at 305_000 (5s past 5min target); within
    // 30s default but outside a 1-s window.
    const vad: VadSegment[] = [
      { startMs: 0, endMs: 300_000, isSpeech: true },
      { startMs: 300_000, endMs: 310_000, isSpeech: false }, // midpoint 305_000
      { startMs: 310_000, endMs: TEN_MIN, isSpeech: true },
    ];
    const tight = computeChunkBoundaries(TEN_MIN, { vad, silenceSearchWindowMs: 1_000 });
    expect(tight[0]?.endMs).toBe(FIVE_MIN); // hard cut
    const loose = computeChunkBoundaries(TEN_MIN, { vad, silenceSearchWindowMs: 30_000 });
    expect(loose[0]?.endMs).toBe(305_000); // silence cut
  });
});

describe('nearestSilence', () => {
  const vad: VadSegment[] = [
    { startMs: 100, endMs: 200, isSpeech: false }, // mid 150
    { startMs: 800, endMs: 1_000, isSpeech: false }, // mid 900
    { startMs: 1_200, endMs: 1_400, isSpeech: true }, // ignored
  ];

  it('returns the midpoint of the nearest silence segment within the window', () => {
    expect(nearestSilence(vad, 950, 500)).toBe(900);
    expect(nearestSilence(vad, 140, 500)).toBe(150);
  });

  it('returns null when no silence lies within ±window', () => {
    expect(nearestSilence(vad, 5_000, 100)).toBeNull();
  });

  it('ignores speech segments', () => {
    expect(nearestSilence(vad, 1_300, 50)).toBeNull();
  });

  it('returns null on null / empty / malformed input', () => {
    expect(nearestSilence(null, 100, 500)).toBeNull();
    expect(nearestSilence([], 100, 500)).toBeNull();
    expect(
      nearestSilence(
        [
          { startMs: Number.NaN, endMs: 100, isSpeech: false },
          { startMs: 50, endMs: 30, isSpeech: false }, // reversed range
        ] as VadSegment[],
        100,
        500,
      ),
    ).toBeNull();
  });
});

describe('chunkKeyFor', () => {
  it('zero-pads the index to the default width', () => {
    expect(chunkKeyFor('rec-1', 0)).toBe('pipeline-temp/rec-1/chunks/000.opus');
    expect(chunkKeyFor('rec-1', 7)).toBe('pipeline-temp/rec-1/chunks/007.opus');
    expect(chunkKeyFor('rec-1', 142)).toBe('pipeline-temp/rec-1/chunks/142.opus');
  });

  it('exceeding the pad width emits a wider number rather than truncating', () => {
    expect(chunkKeyFor('rec-1', 1_234)).toBe('pipeline-temp/rec-1/chunks/1234.opus');
  });

  it('honours custom pad + prefix', () => {
    expect(chunkKeyFor('rec-1', 3, { pad: 5, prefix: 'p/q' })).toBe('p/q/00003.opus');
  });

  it('throws on invalid arguments', () => {
    expect(() => chunkKeyFor('', 0)).toThrow(/non-empty string/);
    expect(() => chunkKeyFor('r', -1)).toThrow(/non-negative integer/);
    expect(() => chunkKeyFor('r', 1.5)).toThrow(/non-negative integer/);
  });
});

describe('stitchTranscripts', () => {
  const chunkWord = (word: string, startMs: number, endMs: number): WordTimestamp => ({
    word,
    startMs,
    endMs,
  });

  it('concatenates text and shifts words onto the global clock', () => {
    const out = stitchTranscripts([
      {
        boundary: { startMs: 0, endMs: 5_000, index: 0 },
        text: 'SKYKING SKYKING',
        words: [chunkWord('SKYKING', 0, 1_000), chunkWord('SKYKING', 1_200, 2_200)],
      },
      {
        boundary: { startMs: 5_000, endMs: 10_000, index: 1 },
        text: 'DELTA OSCAR',
        words: [chunkWord('DELTA', 0, 500), chunkWord('OSCAR', 800, 1_400)],
      },
    ]);
    expect(out.text).toBe('SKYKING SKYKING DELTA OSCAR');
    expect(out.words).toEqual([
      chunkWord('SKYKING', 0, 1_000),
      chunkWord('SKYKING', 1_200, 2_200),
      chunkWord('DELTA', 5_000, 5_500),
      chunkWord('OSCAR', 5_800, 6_400),
    ]);
  });

  it('skips empty-text chunks in the text join (silence-only chunks)', () => {
    const out = stitchTranscripts([
      {
        boundary: { startMs: 0, endMs: 5_000, index: 0 },
        text: 'A',
        words: [chunkWord('A', 0, 100)],
      },
      {
        boundary: { startMs: 5_000, endMs: 10_000, index: 1 },
        text: '   ',
        words: [],
      },
      {
        boundary: { startMs: 10_000, endMs: 15_000, index: 2 },
        text: 'B',
        words: [chunkWord('B', 0, 100)],
      },
    ]);
    expect(out.text).toBe('A B');
  });

  it('returns an empty result on empty / non-array input', () => {
    expect(stitchTranscripts([])).toEqual({ text: '', words: [] });
  });
});
