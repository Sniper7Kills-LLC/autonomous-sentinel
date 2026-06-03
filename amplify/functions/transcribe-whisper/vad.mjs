/**
 * In-container voice-activity detection (#671 — folds the #50 DSP stage
 * into the Whisper image).
 *
 * Runs AFTER silence-trim + denoise to identify the speech regions inside
 * the recording. ffmpeg's `silencedetect` filter handles the SDR-broadcast
 * case (clear silence boundaries between transmissions, no overlapping
 * speakers) without the 200+ MB ONNX cost of Silero VAD.
 *
 * `ffmpeg -nostats -i <input> -af silencedetect=noise=-50dB:d=0.5 -f null -`
 * writes stderr lines:
 *   [silencedetect @ ..] silence_start: 12.345
 *   [silencedetect @ ..] silence_end: 15.678 | silence_duration: 3.333
 * We parse those into silence intervals, then invert to the alternating
 * speech/silence `VadSegment[]` covering `[0, totalDurationMs)`.
 *
 * ==== SPLITTER SEAM (more-to-follow, future issue) ====
 * The emitted `segments` (+ `speechMs`/`silenceMs`) ARE the raw material a
 * future "split one Recording into N" task consumes: a long inter-message
 * silence is exactly the "… more to follow, stand by" gap between two
 * back-to-back EAMs. The cut DECISION lives in that future task; this
 * module only produces the speech/silence map. `_shared/chunk.ts` (#59)
 * types around the same `{startMs,endMs,isSpeech}` shape so the long-audio
 * chunker and the splitter share this output.
 *
 * Runtime `.mjs` copy of `preprocess/vad.ts` — kept in sync deliberately.
 * `spawnFn` injectable for tests.
 */
import { spawn } from 'node:child_process';

export const DEFAULT_VAD_NOISE_DB = -50;
export const DEFAULT_VAD_MIN_SILENCE_SEC = 0.5;
export const DEFAULT_FFMPEG_PATH = '/usr/local/bin/ffmpeg';
export const DEFAULT_STDERR_CAPTURE_BYTES = 64 * 1024;

export class VadError extends Error {
  constructor(message, code, stderr) {
    super(message);
    this.name = 'VadError';
    this.code = code;
    this.stderr = stderr;
  }
}

function parseBoundedNumber(raw, fallback, bounds = {}) {
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

/**
 * Reads VAD tunables from env. Out-of-range values fall back to defaults
 * with a warn so a corrupt admin row can't relax the gate to 0 dB
 * (silence-everywhere) or 0 sec (every breath pause breaks a segment).
 */
export function readVadConfig(env = process.env) {
  return {
    noiseDb: parseBoundedNumber(env.VAD_NOISE_DB, DEFAULT_VAD_NOISE_DB, { maxValue: 0 }),
    minSilenceSec: parseBoundedNumber(env.VAD_MIN_SILENCE_SEC, DEFAULT_VAD_MIN_SILENCE_SEC, {
      minValue: 0.01,
    }),
  };
}

/**
 * Parses ffmpeg `silencedetect` stderr into silence intervals. Exposed
 * for tests so the regex is pinnable. An unclosed trailing `silence_start`
 * (recording ends in silence) is closed at `totalDurationMs`.
 */
export function parseSilenceDetect(stderr, totalDurationMs) {
  const out = [];
  let openStartMs = null;
  const startRe = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
  const endRe = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;
  const tokens = [];
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
        // Second `silence_start` without a close — close the previous at
        // this point so we don't lose it.
        out.push({ startMs: openStartMs, endMs: ms });
      }
      openStartMs = ms;
    } else {
      if (openStartMs !== null) {
        out.push({ startMs: openStartMs, endMs: Math.max(openStartMs, ms) });
        openStartMs = null;
      }
      // Unmatched `silence_end` (recording opens mid-silence) is dropped.
    }
  }
  if (openStartMs !== null) {
    out.push({ startMs: openStartMs, endMs: Math.max(openStartMs, totalDurationMs) });
  }
  return out;
}

/**
 * Inverts a silence-interval list into the alternating speech+silence
 * `VadSegment[]` covering `[0, totalDurationMs)`.
 */
export function buildSegments(silences, totalDurationMs) {
  const segments = [];
  let cursor = 0;
  const sorted = silences
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .map((s) => ({
      startMs: Math.max(0, Math.min(s.startMs, totalDurationMs)),
      endMs: Math.max(0, Math.min(s.endMs, totalDurationMs)),
    }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  // Merge overlapping / adjacent silences so the walk can't emit two
  // silences in a row (defends against malformed stderr).
  const cleaned = [];
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

export function summarise(segments) {
  let speechMs = 0;
  let silenceMs = 0;
  for (const seg of segments) {
    const dur = Math.max(0, seg.endMs - seg.startMs);
    if (seg.isSpeech) speechMs += dur;
    else silenceMs += dur;
  }
  return { speechMs, silenceMs };
}

export function buildArgs(inputPath, noiseDb, minSilenceSec) {
  // `-f null -` discards output — silencedetect only produces stderr
  // metadata. `-nostats` keeps stderr small.
  return [
    '-nostats',
    '-i',
    inputPath,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    '-f',
    'null',
    '-',
  ];
}

/**
 * Runs ffmpeg silencedetect on the cleaned recording. Resolves with the
 * `VadSegment[]` + totals. Rejects with `VadError` on non-zero ffmpeg exit.
 */
export function runVad(opts) {
  const inputPath = opts?.inputPath;
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return Promise.reject(new Error('runVad: inputPath required'));
  }
  if (!Number.isFinite(opts.totalDurationMs) || opts.totalDurationMs <= 0) {
    return Promise.reject(new Error('runVad: totalDurationMs must be a positive finite number'));
  }
  const noiseDb = opts.noiseDb ?? DEFAULT_VAD_NOISE_DB;
  const minSilenceSec = opts.minSilenceSec ?? DEFAULT_VAD_MIN_SILENCE_SEC;
  const ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || DEFAULT_FFMPEG_PATH;
  const spawnFn = opts.spawnFn || spawn;
  const args = buildArgs(inputPath, noiseDb, minSilenceSec);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
    child.stderr?.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const combined = Buffer.concat([stderrBuf, buf]);
      stderrBuf =
        combined.byteLength > DEFAULT_STDERR_CAPTURE_BYTES
          ? combined.subarray(combined.byteLength - DEFAULT_STDERR_CAPTURE_BYTES)
          : combined;
    });
    const decode = () => stderrBuf.toString('utf8');

    child.once('error', (err) => {
      reject(new VadError(`runVad: spawn error: ${err.message}`, null, decode()));
    });
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new VadError(`runVad: ffmpeg exited with code ${code ?? 'null'}`, code, decode()));
        return;
      }
      const silences = parseSilenceDetect(decode(), opts.totalDurationMs);
      const segments = buildSegments(silences, opts.totalDurationMs);
      resolve({ segments, ...summarise(segments) });
    });
  });
}
