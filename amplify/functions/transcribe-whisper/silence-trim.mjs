/**
 * In-container silence-trim (#671 — folds the #49 DSP stage into the
 * Whisper image).
 *
 * Strips leading + trailing silence from the original upload before
 * VAD / denoise / transcode so the downstream stages don't burn cycles
 * on the band noise SDR captures carry on either side of a broadcast.
 * Symmetric `silenceremove` + `areverse` filter chain (trim leading,
 * reverse, trim leading again = original trailing, reverse back).
 *
 * Runtime `.mjs` copy of `preprocess/silence-trim.ts` — kept in sync
 * deliberately, same as `opus-transcode.mjs`. The reference TS module
 * carries the canonical doc + unit tests; this ships into the image.
 *
 * `spawnFn` injectable so the unit test drives argv + exit handling
 * without a real ffmpeg.
 */
import { spawn } from 'node:child_process';

export const DEFAULT_SILENCE_THRESHOLD_DB = -50;
export const DEFAULT_SILENCE_MIN_SEC = 1.0;
export const DEFAULT_FFMPEG_PATH = '/usr/local/bin/ffmpeg';
export const DEFAULT_STDERR_CAPTURE_BYTES = 4096;

export class SilenceTrimError extends Error {
  constructor(message, code, stderr) {
    super(message);
    this.name = 'SilenceTrimError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Builds the ffmpeg `-af` filter chain. Exposed for tests so the
 * encoded threshold + min-silence are pinnable.
 */
export function buildFilterChain(thresholdDb, minSilenceSec) {
  const trim = `silenceremove=start_periods=1:start_threshold=${thresholdDb}dB:start_silence=${minSilenceSec}`;
  return [trim, 'areverse', trim, 'areverse'].join(',');
}

function parseBoundedNumber(raw, fallback, bounds = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn('silence-trim: ignoring non-finite env value', { raw, fallback });
    return fallback;
  }
  if (bounds.minValue !== undefined && n < bounds.minValue) {
    console.warn('silence-trim: ignoring env value below minimum', {
      raw,
      min: bounds.minValue,
      fallback,
    });
    return fallback;
  }
  if (bounds.maxValue !== undefined && n > bounds.maxValue) {
    console.warn('silence-trim: ignoring env value above maximum', {
      raw,
      max: bounds.maxValue,
      fallback,
    });
    return fallback;
  }
  return n;
}

/**
 * Reads silence-trim tunables from env. Out-of-range / unparseable
 * values fall back to the defaults so a typo can't relax the gate to
 * 0 dB (silence-everywhere) or a 0-sec window (trim one sample).
 */
export function readSilenceConfig(env = process.env) {
  return {
    thresholdDb: parseBoundedNumber(env.SILENCE_THRESHOLD_DB, DEFAULT_SILENCE_THRESHOLD_DB, {
      maxValue: 0,
    }),
    minSilenceSec: parseBoundedNumber(env.SILENCE_MIN_SEC, DEFAULT_SILENCE_MIN_SEC, {
      minValue: 0.01,
    }),
  };
}

export function buildArgs(inputPath, outputPath, filter) {
  // `-y` overwrites a partial file from a prior failed run. `-loglevel
  // error` keeps stderr to failure context only.
  return ['-y', '-loglevel', 'error', '-i', inputPath, '-af', filter, outputPath];
}

/**
 * Runs ffmpeg with the symmetric `silenceremove` chain. Resolves on
 * exit 0; rejects with `SilenceTrimError` on any other code / spawn
 * failure.
 */
export function silenceTrim(opts) {
  const inputPath = opts?.inputPath;
  const outputPath = opts?.outputPath;
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return Promise.reject(new Error('silenceTrim: inputPath required'));
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    return Promise.reject(new Error('silenceTrim: outputPath required'));
  }
  if (inputPath === outputPath) {
    return Promise.reject(new Error('silenceTrim: inputPath and outputPath must differ'));
  }

  const thresholdDb = opts.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
  const minSilenceSec = opts.minSilenceSec ?? DEFAULT_SILENCE_MIN_SEC;
  const ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || DEFAULT_FFMPEG_PATH;
  const spawnFn = opts.spawnFn || spawn;
  const filter = buildFilterChain(thresholdDb, minSilenceSec);
  const args = buildArgs(inputPath, outputPath, filter);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(
        new SilenceTrimError(
          `silenceTrim: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          null,
          '',
        ),
      );
      return;
    }

    // Byte-level rolling tail decoded once at the end so a multi-byte
    // UTF-8 char straddling the boundary doesn't surface as ``.
    let stderrTailBuf = Buffer.alloc(0);
    child.stderr?.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const combined = Buffer.concat([stderrTailBuf, buf]);
      stderrTailBuf =
        combined.byteLength > DEFAULT_STDERR_CAPTURE_BYTES
          ? combined.subarray(combined.byteLength - DEFAULT_STDERR_CAPTURE_BYTES)
          : combined;
    });
    const decode = () => stderrTailBuf.toString('utf8');

    child.once('error', (err) => {
      reject(new SilenceTrimError(`silenceTrim: spawn error: ${err.message}`, null, decode()));
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ inputPath, outputPath, thresholdDb, minSilenceSec, stderrTail: decode() });
        return;
      }
      reject(
        new SilenceTrimError(
          `silenceTrim: ffmpeg exited with code ${code ?? 'null'}`,
          code,
          decode(),
        ),
      );
    });
  });
}
