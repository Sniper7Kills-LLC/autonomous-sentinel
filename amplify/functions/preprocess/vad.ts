import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { VadSegment } from '../_shared/chunk';

/**
 * Voice activity detection helper for the pre-process Lambda
 * (#50). Runs AFTER silence-trim (#49) to identify the
 * speech regions inside the recording.
 *
 * Implementation note: spec sketch suggests Silero VAD via ONNX,
 * but ffmpeg's built-in `silencedetect` filter handles the
 * SDR-broadcast use case (clear silence boundaries between
 * transmissions, no overlapping speakers) without the 200+ MB
 * ONNX runtime layer cost. The ffmpeg binary is already in the
 * pre-process layer for #49, so #50 stays cold-start-cheap.
 * Filing follow-up issue tracks Silero swap if quality demands.
 *
 * Strategy: invoke `ffmpeg -i <input> -af silencedetect=noise=
 * -50dB:d=0.5 -f null -`. ffmpeg writes stderr lines:
 *   [silencedetect @ 0x...] silence_start: 12.345
 *   [silencedetect @ 0x...] silence_end: 15.678 | silence_duration: 3.333
 * We parse these into silence intervals, then compute the
 * complementary speech intervals as `{startMs, endMs, isSpeech}`
 * segments matching the existing `_shared/chunk.ts` shape.
 *
 * Tunables (env, validated):
 *   - `VAD_NOISE_DB` — default `-50`. Threshold below which
 *     audio counts as silence. Same gate as #49 trim.
 *   - `VAD_MIN_SILENCE_SEC` — default `0.5`. Silence durations
 *     shorter than this don't break a speech segment (breath
 *     pauses, codeword gaps).
 *
 * Output:
 *   - `segments[]` — alternating speech + silence intervals
 *     covering the full duration. Speech-only callers filter
 *     `isSpeech === true`.
 *   - `speechMs` — total speech duration; lands on the
 *     deferred `Recording.speechDurationMs` field for analytics.
 */

export const DEFAULT_VAD_NOISE_DB = -50;
export const DEFAULT_VAD_MIN_SILENCE_SEC = 0.5;
export const DEFAULT_FFMPEG_BINARY = 'ffmpeg';
export const DEFAULT_STDERR_CAPTURE_BYTES = 64 * 1024;

export interface VadOpts {
  inputPath: string;
  /** Total recording duration in ms. Required — see notes below. */
  totalDurationMs: number;
  noiseDb?: number;
  minSilenceSec?: number;
  ffmpegBinary?: string;
  spawnFn?: typeof spawn;
}

export interface VadResult {
  segments: VadSegment[];
  speechMs: number;
  silenceMs: number;
}

export class VadError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = 'VadError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Reads VAD tunables from env. Out-of-range values fall back to
 * defaults with a warn — a corrupt admin row can't relax the
 * gate to 0 dB (= silence-everywhere) or 0 sec (= every breath
 * pause breaks a segment).
 */
export function readVadConfig(env: Record<string, string | undefined> = process.env): {
  noiseDb: number;
  minSilenceSec: number;
} {
  return {
    noiseDb: parseBoundedNumber(env.VAD_NOISE_DB, DEFAULT_VAD_NOISE_DB, { maxValue: 0 }),
    minSilenceSec: parseBoundedNumber(env.VAD_MIN_SILENCE_SEC, DEFAULT_VAD_MIN_SILENCE_SEC, {
      minValue: 0.01,
    }),
  };
}

interface ParseBounds {
  minValue?: number;
  maxValue?: number;
}

function parseBoundedNumber(
  raw: string | undefined,
  fallback: number,
  bounds: ParseBounds = {},
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn('vad: ignoring non-finite env value', { raw, fallback });
    return fallback;
  }
  if (bounds.minValue !== undefined && n < bounds.minValue) {
    console.warn('vad: ignoring env value below minimum', { raw, min: bounds.minValue, fallback });
    return fallback;
  }
  if (bounds.maxValue !== undefined && n > bounds.maxValue) {
    console.warn('vad: ignoring env value above maximum', { raw, max: bounds.maxValue, fallback });
    return fallback;
  }
  return n;
}

interface SilenceInterval {
  startMs: number;
  endMs: number;
}

/**
 * Parses ffmpeg `silencedetect` stderr into silence intervals.
 * Exposed for tests so the stderr-line regex is pinnable.
 *
 * `silence_start: <s>` opens an interval; the next
 * `silence_end: <s>` closes it. If the last interval has no
 * matching `silence_end` (recording ends in silence), the helper
 * closes it at `totalDurationMs`.
 */
export function parseSilenceDetect(stderr: string, totalDurationMs: number): SilenceInterval[] {
  const out: SilenceInterval[] = [];
  let openStartMs: number | null = null;
  // Match both signed + decimal: silence_start: -1.234 or 12.345
  const startRe = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
  const endRe = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;
  // Walk both regex streams in lock-step by scanning the full
  // stderr text in order. Use a combined match approach so a
  // missing `_end` doesn't desync the pairing.
  const tokens: Array<{ kind: 'start' | 'end'; sec: number; idx: number }> = [];
  for (const m of stderr.matchAll(startRe)) {
    tokens.push({ kind: 'start', sec: Number(m[1]), idx: m.index ?? 0 });
  }
  for (const m of stderr.matchAll(endRe)) {
    tokens.push({ kind: 'end', sec: Number(m[1]), idx: m.index ?? 0 });
  }
  tokens.sort((a, b) => a.idx - b.idx);

  for (const tok of tokens) {
    if (!Number.isFinite(tok.sec)) continue;
    const ms = Math.max(0, Math.round(tok.sec * 1000));
    if (tok.kind === 'start') {
      if (openStartMs !== null) {
        // A second `silence_start` without a prior close — close
        // the previous one at this point so we don't lose it.
        out.push({ startMs: openStartMs, endMs: ms });
      }
      openStartMs = ms;
    } else {
      // 'end'
      if (openStartMs !== null) {
        out.push({ startMs: openStartMs, endMs: Math.max(openStartMs, ms) });
        openStartMs = null;
      }
      // An unmatched `silence_end` (open never seen) is dropped —
      // ffmpeg sometimes emits these on the very first window
      // when the recording opens mid-silence.
    }
  }
  if (openStartMs !== null) {
    // Trailing silence open at end of recording.
    out.push({ startMs: openStartMs, endMs: Math.max(openStartMs, totalDurationMs) });
  }
  return out;
}

/**
 * Inverts a silence-interval list into the alternating
 * speech+silence segment list (`VadSegment[]`) covering
 * `[0, totalDurationMs)`. Used by the chunker (#59) which
 * needs the boundaries either way.
 */
export function buildSegments(silences: SilenceInterval[], totalDurationMs: number): VadSegment[] {
  const segments: VadSegment[] = [];
  let cursor = 0;
  // Drop silence intervals that are entirely outside the
  // duration window or invalid; clamp the rest.
  const sorted = silences
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .map((s) => ({
      startMs: Math.max(0, Math.min(s.startMs, totalDurationMs)),
      endMs: Math.max(0, Math.min(s.endMs, totalDurationMs)),
    }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  // Merge overlapping / adjacent silence intervals so the
  // segment walk below cannot emit two silences in a row.
  // ffmpeg shouldn't produce overlapping silences in practice,
  // but a malformed stderr (mid-line truncation, mis-ordered
  // start/end pairs) could; cheaper to fix once here than to
  // chase the bug at every consumer.
  const cleaned: SilenceInterval[] = [];
  for (const s of sorted) {
    const last = cleaned[cleaned.length - 1];
    if (last && s.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, s.endMs);
    } else {
      cleaned.push({ ...s });
    }
  }

  for (const s of cleaned) {
    if (s.startMs > cursor) {
      segments.push({ startMs: cursor, endMs: s.startMs, isSpeech: true });
    }
    segments.push({ startMs: s.startMs, endMs: s.endMs, isSpeech: false });
    cursor = s.endMs;
  }
  if (cursor < totalDurationMs) {
    segments.push({ startMs: cursor, endMs: totalDurationMs, isSpeech: true });
  }
  return segments;
}

export function summarise(segments: VadSegment[]): { speechMs: number; silenceMs: number } {
  let speechMs = 0;
  let silenceMs = 0;
  for (const seg of segments) {
    const dur = Math.max(0, seg.endMs - seg.startMs);
    if (seg.isSpeech) speechMs += dur;
    else silenceMs += dur;
  }
  return { speechMs, silenceMs };
}

/**
 * Runs ffmpeg silencedetect on the trimmed recording. Returns
 * the segments + totals. Throws `VadError` on any non-zero
 * ffmpeg exit + carries the stderr tail for DLQ context.
 */
export function runVad(opts: VadOpts): Promise<VadResult> {
  if (typeof opts.inputPath !== 'string' || opts.inputPath.length === 0) {
    return Promise.reject(new Error('runVad: inputPath required'));
  }
  if (!Number.isFinite(opts.totalDurationMs) || opts.totalDurationMs <= 0) {
    return Promise.reject(new Error('runVad: totalDurationMs must be a positive finite number'));
  }
  const noiseDb = opts.noiseDb ?? DEFAULT_VAD_NOISE_DB;
  const minSilenceSec = opts.minSilenceSec ?? DEFAULT_VAD_MIN_SILENCE_SEC;
  const ffmpegBinary = opts.ffmpegBinary ?? DEFAULT_FFMPEG_BINARY;
  const spawnFn = opts.spawnFn ?? spawn;

  // `-f null -` discards the output stream — silencedetect only
  // produces stderr metadata. `-nostats` keeps stderr small.
  const args = [
    '-nostats',
    '-i',
    opts.inputPath,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    '-f',
    'null',
    '-',
  ];

  return new Promise<VadResult>((resolve, reject) => {
    let child;
    const spawnOpts: SpawnOptions = { stdio: ['ignore', 'ignore', 'pipe'] };
    try {
      child = spawnFn(ffmpegBinary, args, spawnOpts);
    } catch (err) {
      reject(
        new VadError(
          `runVad: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          null,
          '',
        ),
      );
      return;
    }

    let stderrBuf = Buffer.alloc(0);
    const stderr = child.stderr;
    if (stderr) {
      stderr.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        const combined = Buffer.concat([stderrBuf, buf]);
        stderrBuf =
          combined.byteLength > DEFAULT_STDERR_CAPTURE_BYTES
            ? combined.subarray(combined.byteLength - DEFAULT_STDERR_CAPTURE_BYTES)
            : combined;
      });
    }

    const decode = (): string => stderrBuf.toString('utf8');

    child.once('error', (err: Error) => {
      reject(new VadError(`runVad: spawn error: ${err.message}`, null, decode()));
    });

    child.once('close', (code: number | null) => {
      if (code !== 0) {
        reject(new VadError(`runVad: ffmpeg exited with code ${code ?? 'null'}`, code, decode()));
        return;
      }
      const stderrText = decode();
      const silences = parseSilenceDetect(stderrText, opts.totalDurationMs);
      const segments = buildSegments(silences, opts.totalDurationMs);
      const totals = summarise(segments);
      resolve({ segments, ...totals });
    });
  });
}
