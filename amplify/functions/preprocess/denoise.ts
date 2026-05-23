import { copyFile } from 'node:fs/promises';
import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';

/**
 * Noise reduction helper for the pre-process Lambda (#51).
 *
 * Reads the silence-trimmed WAV from #49, optionally applies
 * frequency-domain denoising, and writes the result for the
 * transcode stage (#52) to consume. Per CLAUDE.md → Pipeline
 * components ("noise reduction"); the v1 implementation uses
 * ffmpeg's built-in `afftdn` filter — no extra Lambda layer
 * cost, decent quality on HF voice traffic.
 *
 * Mode switch (`NOISE_REDUCTION_MODE` env):
 *   - `'off'`     — byte-identical file copy. Used when
 *                   reproducing a transcript bug or in dev so
 *                   denoising can't mask real audio defects.
 *                   Default in sandbox / dev.
 *   - `'afftdn'`  — ffmpeg `afftdn=nr=<nrDb>:nf=<nfDb>` filter.
 *                   Default in prod.
 *   - `'rnnoise'` — throws `RnnoiseNotImplemented` until the
 *                   RNNoise WASM layer ships behind a feature
 *                   flag. Tracker: deferred follow-up.
 *
 * Tunables (env, validated):
 *   - `NOISE_REDUCTION_NR_DB` — afftdn `nr` (noise reduction
 *     amount). Default `12`. Range `0` – `97` per ffmpeg docs.
 *   - `NOISE_REDUCTION_NF_DB` — afftdn `nf` (noise floor).
 *     Default `-25`. Below the gate, denoising aggression
 *     ramps up. Range `-80` – `-20`.
 *
 * Pure JS. Injectable `spawnFn` + `copyFileFn` test seams so
 * vitest never shells out / touches the real filesystem.
 */

export type NoiseReductionMode = 'off' | 'afftdn' | 'rnnoise';

export const NOISE_REDUCTION_MODES: readonly NoiseReductionMode[] = [
  'off',
  'afftdn',
  'rnnoise',
] as const;

export const DEFAULT_NOISE_REDUCTION_MODE: NoiseReductionMode = 'afftdn';
export const DEFAULT_NR_DB = 12;
export const DEFAULT_NF_DB = -25;
export const DEFAULT_FFMPEG_BINARY = 'ffmpeg';
export const DEFAULT_STDERR_CAPTURE_BYTES = 4096;

export interface DenoiseOpts {
  inputPath: string;
  outputPath: string;
  mode?: NoiseReductionMode;
  nrDb?: number;
  nfDb?: number;
  ffmpegBinary?: string;
  spawnFn?: typeof spawn;
  copyFileFn?: typeof copyFile;
}

export interface DenoiseResult {
  inputPath: string;
  outputPath: string;
  mode: NoiseReductionMode;
  nrDb: number | null;
  nfDb: number | null;
  stderrTail: string;
}

export class DenoiseError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = 'DenoiseError';
    this.code = code;
    this.stderr = stderr;
  }
}

export class RnnoiseNotImplemented extends Error {
  constructor() {
    super('denoise: NOISE_REDUCTION_MODE=rnnoise selected but RNNoise WASM layer not yet shipped');
    this.name = 'RnnoiseNotImplemented';
  }
}

export function isNoiseReductionMode(value: unknown): value is NoiseReductionMode {
  return typeof value === 'string' && (NOISE_REDUCTION_MODES as readonly string[]).includes(value);
}

/**
 * Reads denoise tunables from env. Out-of-range values fall
 * back to defaults + warn so a fat-finger admin can't break
 * the gate.
 */
export function readDenoiseConfig(env: Record<string, string | undefined> = process.env): {
  mode: NoiseReductionMode;
  nrDb: number;
  nfDb: number;
} {
  const rawMode = env.NOISE_REDUCTION_MODE;
  let mode: NoiseReductionMode = DEFAULT_NOISE_REDUCTION_MODE;
  if (isNoiseReductionMode(rawMode)) {
    mode = rawMode;
  } else if (rawMode) {
    console.warn('denoise: ignoring unknown NOISE_REDUCTION_MODE', {
      raw: rawMode,
      fallback: DEFAULT_NOISE_REDUCTION_MODE,
    });
  }
  return {
    mode,
    nrDb: parseBoundedNumber(env.NOISE_REDUCTION_NR_DB, DEFAULT_NR_DB, {
      minValue: 0,
      maxValue: 97,
    }),
    nfDb: parseBoundedNumber(env.NOISE_REDUCTION_NF_DB, DEFAULT_NF_DB, {
      minValue: -80,
      maxValue: -20,
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
    console.warn('denoise: ignoring non-finite env value', { raw, fallback });
    return fallback;
  }
  if (bounds.minValue !== undefined && n < bounds.minValue) {
    console.warn('denoise: ignoring env value below minimum', {
      raw,
      min: bounds.minValue,
      fallback,
    });
    return fallback;
  }
  if (bounds.maxValue !== undefined && n > bounds.maxValue) {
    console.warn('denoise: ignoring env value above maximum', {
      raw,
      max: bounds.maxValue,
      fallback,
    });
    return fallback;
  }
  return n;
}

/**
 * Builds the ffmpeg `-af afftdn=...` filter expression.
 * Exposed for tests so the encoded nr/nf are pinnable.
 */
export function buildAfftdnFilter(nrDb: number, nfDb: number): string {
  return `afftdn=nr=${nrDb}:nf=${nfDb}`;
}

/**
 * Runs the configured denoise mode against `inputPath`,
 * producing `outputPath`. Resolves with the mode used + nr/nf
 * applied (null for `off` mode) + captured stderr tail.
 *
 * Mode dispatch:
 *   - `off`     → `copyFile(input, output)`. No shell-out.
 *   - `afftdn`  → ffmpeg with the symmetric `-y -loglevel error
 *                 -i input -af afftdn=... output` invocation.
 *                 Same UTF-8-safe stderr capture as #49/#50.
 *   - `rnnoise` → throws `RnnoiseNotImplemented`.
 *
 * Throws `DenoiseError` on ffmpeg non-zero exit / spawn failure.
 */
export async function denoise(opts: DenoiseOpts): Promise<DenoiseResult> {
  if (typeof opts.inputPath !== 'string' || opts.inputPath.length === 0) {
    throw new Error('denoise: inputPath required');
  }
  if (typeof opts.outputPath !== 'string' || opts.outputPath.length === 0) {
    throw new Error('denoise: outputPath required');
  }
  if (opts.inputPath === opts.outputPath) {
    // copyFile of a file onto itself truncates it on most
    // filesystems (POSIX leaves it undefined); ffmpeg `-y -i x
    // -af ... x` would re-read the stream it just overwrote.
    // Either way the input is lost. Reject loudly so the
    // deferred handler picks a distinct pipeline-temp/ path.
    throw new Error('denoise: inputPath and outputPath must differ');
  }
  const mode = opts.mode ?? DEFAULT_NOISE_REDUCTION_MODE;

  if (mode === 'off') {
    const copyFn = opts.copyFileFn ?? copyFile;
    await copyFn(opts.inputPath, opts.outputPath);
    return {
      inputPath: opts.inputPath,
      outputPath: opts.outputPath,
      mode: 'off',
      nrDb: null,
      nfDb: null,
      stderrTail: '',
    };
  }

  if (mode === 'rnnoise') {
    throw new RnnoiseNotImplemented();
  }

  const nrDb = opts.nrDb ?? DEFAULT_NR_DB;
  const nfDb = opts.nfDb ?? DEFAULT_NF_DB;
  const ffmpegBinary = opts.ffmpegBinary ?? DEFAULT_FFMPEG_BINARY;
  const spawnFn = opts.spawnFn ?? spawn;
  const filter = buildAfftdnFilter(nrDb, nfDb);

  const args = ['-y', '-loglevel', 'error', '-i', opts.inputPath, '-af', filter, opts.outputPath];

  return new Promise<DenoiseResult>((resolve, reject) => {
    let child;
    const spawnOpts: SpawnOptions = { stdio: ['ignore', 'ignore', 'pipe'] };
    try {
      child = spawnFn(ffmpegBinary, args, spawnOpts);
    } catch (err) {
      reject(
        new DenoiseError(
          `denoise: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
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
      reject(new DenoiseError(`denoise: spawn error: ${err.message}`, null, decode()));
    });

    child.once('close', (code: number | null) => {
      if (code === 0) {
        resolve({
          inputPath: opts.inputPath,
          outputPath: opts.outputPath,
          mode: 'afftdn',
          nrDb,
          nfDb,
          stderrTail: decode(),
        });
        return;
      }
      reject(
        new DenoiseError(`denoise: ffmpeg exited with code ${code ?? 'null'}`, code, decode()),
      );
    });
  });
}
