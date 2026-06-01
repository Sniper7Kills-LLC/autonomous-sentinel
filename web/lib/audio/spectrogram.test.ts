import { describe, it, expect } from 'vitest';
import {
  computeFrameCount,
  frameOffsets,
  magnitudeToViridis,
  spectrogramCacheKey,
  downsampleFrames,
  InMemorySpectrogramStore,
  estimateFrameWorkload,
} from './spectrogram';

describe('computeFrameCount / frameOffsets', () => {
  it('counts frames for a 256-window 50%-overlap (hop 128) layout', () => {
    // 1024 samples, window 256, hop 128:
    // offsets 0,128,...,768 = 7 full windows (last full window starts at 768,
    // ends at 1024). Next start 896 would overrun → not counted.
    expect(computeFrameCount(1024, 256, 128)).toBe(7);
  });

  it('returns 0 frames when the signal is shorter than one window', () => {
    expect(computeFrameCount(100, 256, 128)).toBe(0);
  });

  it('returns exactly 1 frame when the signal equals the window', () => {
    expect(computeFrameCount(256, 256, 128)).toBe(1);
  });

  it('produces hop-spaced offsets, none of which overrun the signal', () => {
    const offsets = frameOffsets(1024, 256, 128);
    expect(offsets).toEqual([0, 128, 256, 384, 512, 640, 768]);
    for (const o of offsets) {
      expect(o + 256).toBeLessThanOrEqual(1024);
    }
  });

  it('frameOffsets length matches computeFrameCount', () => {
    expect(frameOffsets(5000, 256, 128).length).toBe(computeFrameCount(5000, 256, 128));
  });

  it('guards against a non-positive hop (treats as a single frame at 0)', () => {
    expect(computeFrameCount(1024, 256, 0)).toBe(0);
    expect(frameOffsets(1024, 256, 0)).toEqual([]);
  });
});

describe('magnitudeToViridis', () => {
  it('clamps inputs below 0 to the dark end', () => {
    const c = magnitudeToViridis(-5);
    expect(c).toEqual(magnitudeToViridis(0));
  });

  it('clamps inputs above 1 to the bright end', () => {
    const c = magnitudeToViridis(99);
    expect(c).toEqual(magnitudeToViridis(1));
  });

  it('returns an opaque RGBA quadruple in the byte range', () => {
    const c = magnitudeToViridis(0.5);
    expect(c).toHaveLength(4);
    for (const ch of c) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(255);
      expect(Number.isInteger(ch)).toBe(true);
    }
    expect(c[3]).toBe(255);
  });

  it('is perceptually monotonic in luminance from low to high', () => {
    const lum = (c: readonly number[]) =>
      0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
    const lows = lum(magnitudeToViridis(0.05));
    const mids = lum(magnitudeToViridis(0.5));
    const highs = lum(magnitudeToViridis(0.95));
    expect(lows).toBeLessThan(mids);
    expect(mids).toBeLessThan(highs);
  });
});

describe('spectrogramCacheKey', () => {
  it('namespaces by recording id', () => {
    expect(spectrogramCacheKey('rec-abc')).toBe('spectrogram:v1:rec-abc');
  });

  it('produces distinct keys for distinct ids', () => {
    expect(spectrogramCacheKey('a')).not.toBe(spectrogramCacheKey('b'));
  });
});

describe('downsampleFrames', () => {
  const mkFrames = (n: number, bins: number): Float32Array[] =>
    Array.from({ length: n }, (_, i) => {
      const f = new Float32Array(bins);
      f.fill(i);
      return f;
    });

  it('reduces a wide frame list down to the target width', () => {
    const frames = mkFrames(1000, 4);
    const out = downsampleFrames(frames, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toHaveLength(4);
  });

  it('is a no-op when frames already fit the target width', () => {
    const frames = mkFrames(50, 4);
    const out = downsampleFrames(frames, 100);
    expect(out).toHaveLength(50);
  });

  it('keeps the bin count of the source frames', () => {
    const frames = mkFrames(500, 8);
    const out = downsampleFrames(frames, 60);
    expect(out[0]).toHaveLength(8);
  });

  it('returns an empty list for empty input', () => {
    expect(downsampleFrames([], 100)).toEqual([]);
  });

  it('aggregates by max so loud transients survive the downsample', () => {
    const frames = [
      Float32Array.from([0]),
      Float32Array.from([1]),
      Float32Array.from([0]),
      Float32Array.from([0]),
    ];
    const out = downsampleFrames(frames, 2);
    expect(out).toHaveLength(2);
    // First bucket spans the loud transient → max keeps the 1.
    expect(out[0]?.[0]).toBe(1);
  });
});

describe('estimateFrameWorkload', () => {
  it('scales with sample count and inversely with hop', () => {
    expect(estimateFrameWorkload(48000, 128)).toBe(Math.ceil(48000 / 128));
  });

  it('flags large workloads above the supplied threshold', () => {
    const small = estimateFrameWorkload(48000, 128);
    const big = estimateFrameWorkload(48000 * 600, 128);
    expect(big).toBeGreaterThan(small);
  });
});

describe('InMemorySpectrogramStore', () => {
  it('misses before a put and hits after', async () => {
    const store = new InMemorySpectrogramStore();
    const key = spectrogramCacheKey('rec-1');
    expect(await store.get(key)).toBeNull();
    const payload = { width: 2, bins: 1, data: [Float32Array.from([0.5]), Float32Array.from([1])] };
    await store.put(key, payload);
    const hit = await store.get(key);
    expect(hit).not.toBeNull();
    expect(hit?.width).toBe(2);
    expect(hit?.data[1]?.[0]).toBe(1);
  });

  it('keys are independent', async () => {
    const store = new InMemorySpectrogramStore();
    await store.put(spectrogramCacheKey('a'), {
      width: 1,
      bins: 1,
      data: [Float32Array.from([1])],
    });
    expect(await store.get(spectrogramCacheKey('b'))).toBeNull();
  });
});
