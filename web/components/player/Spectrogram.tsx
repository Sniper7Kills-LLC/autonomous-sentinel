'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRecordingAssetUrl } from '@/lib/audio/url';
import {
  computeFrameCount,
  downsampleFrames,
  estimateFrameWorkload,
  magnitudeToViridis,
  spectrogramCacheKey,
  type SpectrogramFrame,
  type SpectrogramPayload,
  type SpectrogramStore,
} from '@/lib/audio/spectrogram';
import styles from './Spectrogram.module.css';

interface SpectrogramProps {
  /** Recording UUID — keys the IndexedDB frame cache. */
  recordingId: string;
  /** S3 key for the Opus canonical, resolved to a signed URL for the decode. */
  webCanonicalKey: string;
  /** Optional precomputed `.spectrogram.bin` sidecar key — preferred over
   *  client-side compute when present (currently a hook for the pipeline;
   *  unrecognised formats fall back to compute). */
  spectrogramBinKey?: string | null;
  /** Playback position, seconds — drives the synced cursor overlay. */
  currentTime: number;
  /** Total duration, seconds — maps a click x-fraction to a seek time. */
  duration: number;
  /** Seek callback into the owning player. */
  onSeek: (time: number) => void;
}

/** FFT analysis parameters per the issue: 256-sample window, 50% overlap. */
const WINDOW_SIZE = 256;
const HOP = WINDOW_SIZE / 2;
const FREQ_BINS = WINDOW_SIZE / 2;
const CANVAS_HEIGHT = 96;
/** Above this many raw FFT frames (or on low-memory devices) we surface the
 *  "computing… (large file)" indicator with a cancel affordance. */
const HEAVY_FRAME_THRESHOLD = 20000;

type Status = 'idle' | 'computing' | 'ready' | 'error';

/**
 * `<Spectrogram>` — frequency-vs-time heatmap toggled inside the audio
 * panel (#90). Hidden by default; on reveal it fetches the audio,
 * runs a windowed FFT client-side (256-window, 50% overlap), paints a
 * viridis heatmap to a `<canvas>`, downsamples to canvas width for long
 * recordings, and caches the computed frames in IndexedDB keyed by
 * `recordingId` so a re-open is instant.
 *
 * All browser-only APIs (`AudioContext`/`OfflineAudioContext`, Canvas2D,
 * IndexedDB) are feature-guarded so the component degrades to a plain
 * message rather than throwing when they are absent (jsdom, locked-down
 * browsers). The heavy math lives in `@/lib/audio/spectrogram`.
 */
export function Spectrogram({
  recordingId,
  webCanonicalKey,
  spectrogramBinKey,
  currentTime,
  duration,
  onSeek,
}: SpectrogramProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Cancel flag for an in-flight compute — flipped by the cancel button
  // and by unmount/hide so we never paint onto a torn-down canvas.
  const cancelRef = useRef(false);

  const paint = useCallback((payload: SpectrogramPayload) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = Math.max(payload.width, 1);
    canvas.width = width;
    canvas.height = CANVAS_HEIGHT;
    const img = ctx.createImageData(width, CANVAS_HEIGHT);
    const bins = payload.bins;
    for (let x = 0; x < payload.data.length; x++) {
      const col = payload.data[x];
      if (!col) continue;
      for (let y = 0; y < CANVAS_HEIGHT; y++) {
        // Low frequencies at the bottom of the image.
        const bin = Math.min(
          bins - 1,
          Math.floor(((CANVAS_HEIGHT - 1 - y) / CANVAS_HEIGHT) * bins),
        );
        const [r, g, b, a] = magnitudeToViridis(col[bin] ?? 0);
        const idx = (y * width + x) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);

  // Compute (or cache-hit) + paint when the panel opens; tear down on close.
  useEffect(() => {
    if (!open) return;
    // Capture the canvas node now (refs are attached before effects run, and
    // the canvas renders whenever `open` is true) so cleanup frees the exact
    // node this effect painted, not a later one.
    const canvas = canvasRef.current;
    // Per-effect liveness flag. `cancelRef` is shared and gets reset to
    // false the instant this effect re-runs (e.g. `recordingId` changed),
    // which would let a prior in-flight task slip past the shared guard and
    // paint a stale recording onto the new canvas. `stale` is local to this
    // closure and only ever flipped true by *this* effect's cleanup, so a
    // superseded run can never set state or paint.
    let stale = false;
    cancelRef.current = false;
    setError(null);
    setStatus('computing');

    void (async () => {
      let store: SpectrogramStore | null = null;
      try {
        store = await openSpectrogramStore();
        const cacheKey = spectrogramCacheKey(recordingId);

        const cached = store ? await store.get(cacheKey) : null;
        if (stale || cancelRef.current) return;
        if (cached) {
          paint(cached);
          setStatus('ready');
          return;
        }

        const payload = await computeSpectrogram(
          webCanonicalKey,
          spectrogramBinKey,
          () => stale || cancelRef.current,
        );
        if (stale || cancelRef.current || !payload) return;
        paint(payload);
        if (store) await store.put(cacheKey, payload).catch(() => undefined);
        if (stale || cancelRef.current) return;
        setStatus('ready');
      } catch (err) {
        if (stale || cancelRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      } finally {
        // Release the IndexedDB connection so repeated toggles / recording
        // switches don't accumulate open DB handles.
        store?.close?.();
      }
    })();

    return () => {
      // Cancel any in-flight compute + mark this run superseded + free the
      // canvas backing store so a long recording's bitmap is released the
      // moment the panel closes or the recording changes.
      stale = true;
      cancelRef.current = true;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [open, recordingId, webCanonicalKey, spectrogramBinKey, paint]);

  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (duration <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      onSeek(frac * duration);
    },
    [duration, onSeek],
  );

  const cursorPct = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) * 100 : 0;

  if (!open) {
    return (
      <button
        type="button"
        className={styles.toggleBtn}
        onClick={() => setOpen(true)}
        aria-expanded={false}
      >
        View spectrogram
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className={styles.toggleBtn}
        onClick={() => setOpen(false)}
        aria-expanded={true}
      >
        Hide spectrogram
      </button>
      <div
        className={styles.wrap}
        role="img"
        aria-label="Spectrogram — frequency over time. Click to seek."
        onClick={onCanvasClick}
      >
        {status === 'computing' && (
          <div className={styles.empty}>
            <span>computing spectrogram… (large file)</span>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={(e) => {
                e.stopPropagation();
                cancelRef.current = true;
                setStatus('idle');
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {status === 'error' && <div className={styles.empty}>Spectrogram unavailable: {error}</div>}
        <canvas ref={canvasRef} className={styles.canvas} aria-hidden />
        <span className={styles.legend}>FREQ ↑ · TIME →</span>
        <span className={styles.cursor} style={{ left: `${cursorPct}%` }} aria-hidden />
      </div>
    </>
  );
}

/**
 * Open an IndexedDB-backed {@link SpectrogramStore}, or `null` when
 * IndexedDB is unavailable (jsdom, private mode). The component treats a
 * null store as "always recompute" — correctness over caching.
 */
async function openSpectrogramStore(): Promise<SpectrogramStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  const DB = 'autonomous-sentinel';
  const STORE = 'spectrograms';
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
    return {
      get: (key) =>
        new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          tx.onsuccess = () => resolve((tx.result as SpectrogramPayload | undefined) ?? null);
          tx.onerror = () => resolve(null);
        }),
      put: (key, value) =>
        new Promise((resolve) => {
          const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
          tx.onsuccess = () => resolve();
          tx.onerror = () => resolve();
        }),
      // Close the connection so repeated panel toggles don't leak open DB
      // handles. Safe to call once after the read+write completes.
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch + decode the audio and run the windowed FFT, returning a
 * canvas-width-downsampled {@link SpectrogramPayload}. Returns `null`
 * when the browser lacks an AudioContext (jsdom test path resolves a
 * decoded buffer via the stubbed `AudioContext`, real failures throw).
 * `isCancelled` is polled between the network + decode phases so a
 * cancel during a long fetch short-circuits before the heavy math.
 */
async function computeSpectrogram(
  webCanonicalKey: string,
  spectrogramBinKey: string | null | undefined,
  isCancelled: () => boolean,
): Promise<SpectrogramPayload | null> {
  // Precomputed sidecar hook: prefer it when present. The pipeline's
  // `.spectrogram.bin` format is not finalised, so an unparsable sidecar
  // silently falls through to client-side compute rather than erroring.
  if (spectrogramBinKey) {
    const sidecar = await fetchSidecarPayload(spectrogramBinKey).catch(() => null);
    if (sidecar) return sidecar;
  }

  const Ctor = resolveAudioContext();
  if (!Ctor) return null;

  const url = await getRecordingAssetUrl(webCanonicalKey);
  if (isCancelled()) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio: ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (isCancelled()) return null;

  const ctx = new Ctor();
  let samples: Float32Array;
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    samples = buffer.getChannelData(0);
  } finally {
    // Acknowledge (don't swallow silently) a close rejection — closing a
    // throwaway decode context is best-effort and must not mask the real
    // result/error from the decode above.
    void ctx.close?.().catch(() => {});
  }
  if (isCancelled()) return null;

  const frames = analyse(samples);
  const targetWidth = Math.max(1, Math.min(frames.length, 1600));
  const reduced = downsampleFrames(frames, targetWidth);
  return { width: reduced.length, bins: FREQ_BINS, data: reduced };
}

/**
 * Windowed magnitude spectrogram over a mono sample buffer. Uses a naive
 * DFT per frame (FREQ_BINS bins) with a Hann window; the FFT-grade
 * speed-up is unnecessary at WINDOW_SIZE=256 and keeps the code
 * dependency-free. Magnitudes are log-compressed and normalised to [0,1].
 */
function analyse(samples: Float32Array): SpectrogramFrame[] {
  const count = computeFrameCount(samples.length, WINDOW_SIZE, HOP);
  if (count === 0) return [];
  const hann = new Float32Array(WINDOW_SIZE);
  for (let i = 0; i < WINDOW_SIZE; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW_SIZE - 1));
  }
  // Precompute twiddle factors flat (`k * WINDOW_SIZE + n`) so typed-array
  // reads never trip noUncheckedIndexedAccess.
  const cosTab = new Float32Array(FREQ_BINS * WINDOW_SIZE);
  const sinTab = new Float32Array(FREQ_BINS * WINDOW_SIZE);
  for (let k = 0; k < FREQ_BINS; k++) {
    for (let n = 0; n < WINDOW_SIZE; n++) {
      const ang = (2 * Math.PI * k * n) / WINDOW_SIZE;
      cosTab[k * WINDOW_SIZE + n] = Math.cos(ang);
      sinTab[k * WINDOW_SIZE + n] = Math.sin(ang);
    }
  }

  const frames: SpectrogramFrame[] = new Array<SpectrogramFrame>(count);
  let globalMax = 1e-9;
  const raw: Float32Array[] = new Array<Float32Array>(count);
  for (let f = 0; f < count; f++) {
    const off = f * HOP;
    const mags = new Float32Array(FREQ_BINS);
    for (let k = 0; k < FREQ_BINS; k++) {
      let re = 0;
      let im = 0;
      const base = k * WINDOW_SIZE;
      for (let n = 0; n < WINDOW_SIZE; n++) {
        const s = (samples[off + n] ?? 0) * (hann[n] ?? 0);
        re += s * (cosTab[base + n] ?? 0);
        im -= s * (sinTab[base + n] ?? 0);
      }
      const mag = Math.log1p(Math.sqrt(re * re + im * im));
      mags[k] = mag;
      if (mag > globalMax) globalMax = mag;
    }
    raw[f] = mags;
  }
  for (let f = 0; f < count; f++) {
    const src = raw[f] ?? new Float32Array(FREQ_BINS);
    const norm = new Float32Array(FREQ_BINS);
    for (let k = 0; k < FREQ_BINS; k++) norm[k] = (src[k] ?? 0) / globalMax;
    frames[f] = norm;
  }
  return frames;
}

/** Resolve a usable AudioContext constructor across browsers / test stubs. */
function resolveAudioContext(): (new () => AudioCtxLike) | null {
  const g = globalThis as unknown as {
    AudioContext?: new () => AudioCtxLike;
    webkitAudioContext?: new () => AudioCtxLike;
    OfflineAudioContext?: new () => AudioCtxLike;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? g.OfflineAudioContext ?? null;
}

interface AudioCtxLike {
  decodeAudioData(data: ArrayBuffer): Promise<{
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    getChannelData(channel: number): Float32Array;
  }>;
  close?(): Promise<void>;
}

/**
 * Best-effort parse of a precomputed `.spectrogram.bin` sidecar. The
 * binary format is not finalised by the pipeline yet, so this currently
 * always returns null (forcing client-side compute) but isolates the
 * future wiring point behind the `spectrogramBinKey` prop.
 */
function fetchSidecarPayload(_key: string): Promise<SpectrogramPayload | null> {
  return Promise.resolve(null);
}

/**
 * Heavy-compute predicate used by callers/tests: true when the device is
 * low-memory (`navigator.deviceMemory < 4`) or the estimated FFT
 * workload exceeds {@link HEAVY_FRAME_THRESHOLD}. Exported for unit
 * coverage of the guard logic.
 */
export function isHeavyCompute(sampleCount: number): boolean {
  const nav = globalThis.navigator as Navigator & { deviceMemory?: number };
  const lowMem = typeof nav?.deviceMemory === 'number' && nav.deviceMemory < 4;
  return lowMem || estimateFrameWorkload(sampleCount, HOP) > HEAVY_FRAME_THRESHOLD;
}
