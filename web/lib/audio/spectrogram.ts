/**
 * Pure helpers for the `<Spectrogram>` view (#90).
 *
 * Everything in this module is deliberately free of `AudioContext`,
 * `Canvas2D`, and `IndexedDB` so it unit-tests under jsdom. The React
 * glue in `components/player/Spectrogram.tsx` calls into these for the
 * framing math, the magnitude→colour mapping, the cache key, and the
 * downsample-to-canvas-width pass; the browser-only bits (FFT via
 * `OfflineAudioContext`/`AnalyserNode`, canvas blit, real IndexedDB)
 * stay in the component and degrade gracefully when unavailable.
 */

/** A single computed spectrogram column: one magnitude per frequency bin, [0,1]. */
export type SpectrogramFrame = Float32Array;

/** Cached payload — column-major frames plus the canvas geometry they were sized for. */
export interface SpectrogramPayload {
  /** Number of frames (canvas columns) after downsampling. */
  width: number;
  /** Frequency bins per frame (FFT size / 2). */
  bins: number;
  /** `width`-long list of `bins`-long magnitude columns, each value in [0,1]. */
  data: SpectrogramFrame[];
}

/** Minimal async key/value store — lets the component inject a real IndexedDB-backed
 *  store in the browser and tests inject the in-memory one below. */
export interface SpectrogramStore {
  get(key: string): Promise<SpectrogramPayload | null>;
  put(key: string, value: SpectrogramPayload): Promise<void>;
  /** Release any underlying handle (e.g. an open IndexedDB connection).
   *  Optional — the in-memory test double has nothing to release. */
  close?(): void;
}

/**
 * Number of full analysis windows that fit a signal at a given window
 * size + hop. A window only counts when it fits entirely inside the
 * signal (`offset + window <= sampleCount`); partial trailing windows
 * are dropped rather than zero-padded so the heatmap never shows a
 * half-silent final column.
 */
export function computeFrameCount(sampleCount: number, windowSize: number, hop: number): number {
  if (hop <= 0 || windowSize <= 0 || sampleCount < windowSize) return 0;
  return Math.floor((sampleCount - windowSize) / hop) + 1;
}

/** Start sample offset of every frame produced by {@link computeFrameCount}. */
export function frameOffsets(sampleCount: number, windowSize: number, hop: number): number[] {
  const count = computeFrameCount(sampleCount, windowSize, hop);
  const offsets = new Array<number>(count);
  for (let i = 0; i < count; i++) offsets[i] = i * hop;
  return offsets;
}

/**
 * Rough cost estimate for the heavy-compute guard: the number of FFT
 * frames a full client-side decode would produce. Used to decide
 * whether to show the "computing… (large file)" indicator.
 */
export function estimateFrameWorkload(sampleCount: number, hop: number): number {
  if (hop <= 0) return 0;
  return Math.ceil(sampleCount / hop);
}

/**
 * IndexedDB cache key for a recording's computed spectrogram. Versioned
 * so a colormap / FFT-parameter change can invalidate stale caches by
 * bumping the `v` prefix.
 */
export function spectrogramCacheKey(recordingId: string): string {
  return `spectrogram:v1:${recordingId}`;
}

/**
 * Viridis-flavoured magnitude→RGBA mapping. `t` is a normalised
 * magnitude in [0,1] (clamped); returns an opaque 4-tuple `[r,g,b,255]`
 * of integer byte channels. The ramp is a 6-stop piecewise-linear
 * approximation of matplotlib's viridis — perceptually monotonic in
 * luminance, which the unit tests assert.
 */
export function magnitudeToViridis(t: number): [number, number, number, number] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const stops = VIRIDIS_STOPS.length / 3;
  const x = clamped * (stops - 1);
  const lo = Math.floor(x);
  const hi = Math.min(lo + 1, stops - 1);
  const f = x - lo;
  const at = (stop: number, channel: number): number => VIRIDIS_STOPS[stop * 3 + channel] ?? 0;
  return [
    Math.round(at(lo, 0) + (at(hi, 0) - at(lo, 0)) * f),
    Math.round(at(lo, 1) + (at(hi, 1) - at(lo, 1)) * f),
    Math.round(at(lo, 2) + (at(hi, 2) - at(lo, 2)) * f),
    255,
  ];
}

/** 6-stop viridis ramp (dark purple → green → bright yellow), flattened to
 *  `[r,g,b, r,g,b, ...]` so index access never trips noUncheckedIndexedAccess. */
const VIRIDIS_STOPS: readonly number[] = [
  68, 1, 84, 59, 82, 139, 33, 145, 140, 94, 201, 98, 173, 226, 78, 253, 231, 37,
];

/**
 * Downsample a frame list to at most `targetWidth` columns by bucketing
 * consecutive frames and taking the per-bin maximum. Max (not mean) is
 * deliberate: it preserves brief loud transients (e.g. a short tone
 * burst) that an average would smear into the surrounding silence.
 * No-op when the source already fits `targetWidth`.
 */
export function downsampleFrames(
  frames: SpectrogramFrame[],
  targetWidth: number,
): SpectrogramFrame[] {
  if (frames.length === 0) return [];
  if (targetWidth <= 0) return [];
  if (frames.length <= targetWidth) return frames;
  const bins = frames[0]?.length ?? 0;
  const out: SpectrogramFrame[] = new Array<SpectrogramFrame>(targetWidth);
  for (let col = 0; col < targetWidth; col++) {
    const start = Math.floor((col * frames.length) / targetWidth);
    const end = Math.floor(((col + 1) * frames.length) / targetWidth);
    const bucketEnd = Math.max(end, start + 1);
    const agg = new Float32Array(bins);
    for (let fi = start; fi < bucketEnd && fi < frames.length; fi++) {
      const frame = frames[fi];
      if (!frame) continue;
      for (let b = 0; b < bins; b++) {
        const v = frame[b] ?? 0;
        if (v > (agg[b] ?? 0)) agg[b] = v;
      }
    }
    out[col] = agg;
  }
  return out;
}

/**
 * In-memory {@link SpectrogramStore} — the test double, and the
 * graceful fallback the component uses when IndexedDB is unavailable
 * (private-mode browsers, jsdom). Lives in this module so the cache
 * hit/miss contract is exercised by `spectrogram.test.ts` without a
 * real IndexedDB.
 */
export class InMemorySpectrogramStore implements SpectrogramStore {
  private readonly map = new Map<string, SpectrogramPayload>();

  get(key: string): Promise<SpectrogramPayload | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }

  put(key: string, value: SpectrogramPayload): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
}
