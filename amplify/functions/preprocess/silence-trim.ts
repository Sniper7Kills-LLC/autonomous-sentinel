import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';

/**
 * Silence-trim helper for the pre-process Lambda (#49).
 *
 * Strips leading + trailing silence from a recording before VAD
 * (#50), noise reduction (#51), and Opus transcode (#52) so
 * downstream stages don't waste cycles on dead air. SDR uploads
 * routinely include several seconds (sometimes minutes) of band
 * noise on either side of the broadcast; trimming materially
 * cuts cost at scale and tightens the 30-minute SLA per CLAUDE.md.
 *
 * Shells out to `ffmpeg` via `child_process.spawn` so the binary
 * stays in a Lambda layer (separate PR — image build wired via
 * podman in `CDK_DOCKER` mode) and is injectable for tests. The
 * filter chain is the symmetric `silenceremove` + `areverse`
 * pattern from the ffmpeg docs — trim leading, reverse, trim
 * leading again (= original trailing), reverse back.
 *
 * Tunables sourced from env so admins can flex per env:
 *   - `SILENCE_THRESHOLD_DB` — default -50 (anything quieter is
 *     silence). HF voice traffic sits around -25 to -10 dBFS so
 *     -50 is a safe gate that won't eat speech onsets.
 *   - `SILENCE_MIN_SEC` — default 1.0. Pauses shorter than this
 *     are kept (mid-sentence breaths, codeword gaps).
 *
 * Failure modes:
 *   - ffmpeg non-zero exit → throws `SilenceTrimError` carrying
 *     `code` + captured stderr tail. The deferred SQS-driven
 *     retry from #67 catches this for redrive; persistent failure
 *     lands on the pre-process DLQ.
 *   - ffmpeg fails to spawn (binary missing, EACCES) → throws
 *     with the underlying errno.
 */

export const DEFAULT_SILENCE_THRESHOLD_DB = -50;
export const DEFAULT_SILENCE_MIN_SEC = 1.0;
export const DEFAULT_FFMPEG_BINARY = 'ffmpeg';
export const DEFAULT_STDERR_CAPTURE_BYTES = 4096;

export interface SilenceTrimOpts {
  inputPath: string;
  outputPath: string;
  /**
   * dBFS below which audio counts as silence. Default `-50`.
   * Override via env `SILENCE_THRESHOLD_DB` when adjusting for a
   * noisier upload corpus.
   */
  thresholdDb?: number;
  /**
   * Minimum continuous silence (seconds) at the edges that the
   * trimmer will remove. Mid-clip pauses shorter than this are
   * preserved. Default `1.0`.
   */
  minSilenceSec?: number;
  /** ffmpeg binary path. Defaults to `'ffmpeg'` (PATH lookup). */
  ffmpegBinary?: string;
  /**
   * Test seam: injected spawn implementation so vitest never
   * shells out to a real ffmpeg. Default `child_process.spawn`.
   */
  spawnFn?: typeof spawn;
}

export class SilenceTrimError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
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
export function buildFilterChain(thresholdDb: number, minSilenceSec: number): string {
  const trim = `silenceremove=start_periods=1:start_threshold=${thresholdDb}dB:start_silence=${minSilenceSec}`;
  return [trim, 'areverse', trim, 'areverse'].join(',');
}

/**
 * Reads silence-trim tunables from env. Out-of-range / unparseable
 * values fall back to the defaults so a typo doesn't relax the
 * gate to 0 dB (= silence-everywhere) or a 0-sec window (= trim
 * one sample).
 */
export function readSilenceConfig(env: Record<string, string | undefined> = process.env): {
  thresholdDb: number;
  minSilenceSec: number;
} {
  return {
    thresholdDb: parseFiniteNumber(env.SILENCE_THRESHOLD_DB, DEFAULT_SILENCE_THRESHOLD_DB, {
      maxValue: 0,
    }),
    minSilenceSec: parseFiniteNumber(env.SILENCE_MIN_SEC, DEFAULT_SILENCE_MIN_SEC, {
      minValue: 0.01,
    }),
  };
}

interface ParseBounds {
  minValue?: number;
  maxValue?: number;
}

function parseFiniteNumber(
  raw: string | undefined,
  fallback: number,
  bounds: ParseBounds = {},
): number {
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

export interface SilenceTrimResult {
  inputPath: string;
  outputPath: string;
  thresholdDb: number;
  minSilenceSec: number;
  /** Captured stderr tail (last `DEFAULT_STDERR_CAPTURE_BYTES`). */
  stderrTail: string;
}

/**
 * Runs ffmpeg with the symmetric `silenceremove` filter chain.
 * Promise resolves on exit code 0; rejects with
 * `SilenceTrimError` on any other code or spawn failure.
 */
export function silenceTrim(opts: SilenceTrimOpts): Promise<SilenceTrimResult> {
  if (typeof opts.inputPath !== 'string' || opts.inputPath.length === 0) {
    return Promise.reject(new Error('silenceTrim: inputPath required'));
  }
  if (typeof opts.outputPath !== 'string' || opts.outputPath.length === 0) {
    return Promise.reject(new Error('silenceTrim: outputPath required'));
  }

  const thresholdDb = opts.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
  const minSilenceSec = opts.minSilenceSec ?? DEFAULT_SILENCE_MIN_SEC;
  const ffmpegBinary = opts.ffmpegBinary ?? DEFAULT_FFMPEG_BINARY;
  const spawnFn = opts.spawnFn ?? spawn;
  const filter = buildFilterChain(thresholdDb, minSilenceSec);

  // `-y` overwrites the output path if a prior failed run left a
  // partial file behind. `-loglevel error` keeps stderr small —
  // we only want failure context, not info-level progress lines.
  const args = ['-y', '-loglevel', 'error', '-i', opts.inputPath, '-af', filter, opts.outputPath];

  return new Promise<SilenceTrimResult>((resolve, reject) => {
    let child;
    // `stdin: 'ignore'` — handler feeds via `-i path`, no stdin.
    // `stdout: 'ignore'` — `-loglevel error` keeps stdout silent;
    //   leaving it as a pipe with no consumer would let a future
    //   ffmpeg progress write fill the pipe buffer and deadlock.
    // `stderr: 'pipe'` — captured by the rolling tail below for
    //   failure context.
    const spawnOpts: SpawnOptions = { stdio: ['ignore', 'ignore', 'pipe'] };
    try {
      child = spawnFn(ffmpegBinary, args, spawnOpts);
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

    // Capture stderr at the byte level + decode once at the end
    // so a multi-byte UTF-8 char straddling the rolling-byte
    // boundary doesn't surface as `` in the error message.
    let stderrTailBuf = Buffer.alloc(0);
    const stderr = child.stderr;
    if (stderr) {
      stderr.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        const combined = Buffer.concat([stderrTailBuf, buf]);
        stderrTailBuf =
          combined.byteLength > DEFAULT_STDERR_CAPTURE_BYTES
            ? combined.subarray(combined.byteLength - DEFAULT_STDERR_CAPTURE_BYTES)
            : combined;
      });
    }

    const decodeTail = (): string => stderrTailBuf.toString('utf8');

    child.once('error', (err: Error) => {
      reject(new SilenceTrimError(`silenceTrim: spawn error: ${err.message}`, null, decodeTail()));
    });

    child.once('close', (code: number | null) => {
      if (code === 0) {
        resolve({
          inputPath: opts.inputPath,
          outputPath: opts.outputPath,
          thresholdDb,
          minSilenceSec,
          stderrTail: decodeTail(),
        });
        return;
      }
      reject(
        new SilenceTrimError(
          `silenceTrim: ffmpeg exited with code ${code ?? 'null'}`,
          code,
          decodeTail(),
        ),
      );
    });
  });
}
