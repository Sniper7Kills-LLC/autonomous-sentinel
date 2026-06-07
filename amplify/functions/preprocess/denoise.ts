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
 *   - `'rnnoise'` — ffmpeg `arnndn=m=<model>` filter (RNNoise, #476).
 *                   The standard neural denoiser for HF voice;
 *                   typically beats afftdn on narrowband AM/USB
 *                   captures with persistent carrier noise. Uses
 *                   ffmpeg's native `arnndn` filter (the preprocess
 *                   stage is already ffmpeg-based — no WASM/resampling
 *                   glue) against an operator-supplied `.rnnn` model.
 *                   FAILS CLOSED: if the model path is unset the call
 *                   throws (no silent fallback to afftdn/off); if the
 *                   ffmpeg build lacks `arnndn` the non-zero exit
 *                   surfaces as a `DenoiseError`. WER vs afftdn +
 *                   cold-start delta are validated by the operator on
 *                   real HF traffic post-deploy.
 *
 * Tunables (env, validated):
 *   - `NOISE_REDUCTION_NR_DB` — afftdn `nr` (noise reduction
 *     amount). Default `12`. Range `0` – `97` per ffmpeg docs.
 *   - `NOISE_REDUCTION_NF_DB` — afftdn `nf` (noise floor).
 *     Default `-25`. Below the gate, denoising aggression
 *     ramps up. Range `-80` – `-20`.
 *   - `NOISE_REDUCTION_RNNOISE_MODEL` — absolute path to the
 *     `.rnnn` RNNoise model ffmpeg's `arnndn` loads. Required
 *     when mode is `rnnoise`; no default (fail closed).
 *
 * Pure JS. Injectable `spawnFn` + `copyFileFn` test seams so
 * vitest never shells out / touches the real filesystem.
 */

export type NoiseReductionMode = 'off' | 'afftdn' | 'eam' | 'rnnoise';

export const NOISE_REDUCTION_MODES: readonly NoiseReductionMode[] = [
  'off',
  'afftdn',
  'eam',
  'rnnoise',
] as const;

// `eam` (#760): HF-SSB voice chain (bandpass 300–3000 Hz + afftdn + AGC).
// Kept in sync with the active container copy (transcribe-whisper/denoise.mjs).
export const DEFAULT_NOISE_REDUCTION_MODE: NoiseReductionMode = 'eam';
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
  /** Path to the `.rnnn` model for `arnndn`. Required when mode is `rnnoise`. */
  rnnoiseModelPath?: string | null;
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

/**
 * Thrown when `rnnoise` mode is selected but no model path is
 * configured. Fail-closed marker (no silent fallback to afftdn/off)
 * per the #476 acceptance criteria.
 */
export class RnnoiseModelMissing extends Error {
  constructor() {
    super(
      'denoise: NOISE_REDUCTION_MODE=rnnoise requires NOISE_REDUCTION_RNNOISE_MODEL (path to a .rnnn model); refusing to denoise (fail closed)',
    );
    this.name = 'RnnoiseModelMissing';
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
  rnnoiseModelPath: string | null;
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
    rnnoiseModelPath: env.NOISE_REDUCTION_RNNOISE_MODEL || null,
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

/** HF voice band edges for the `eam` chain (#760). */
export const EAM_HIGHPASS_HZ = 300;
export const EAM_LOWPASS_HZ = 3000;

/**
 * Builds the `eam` HF-voice ffmpeg chain (#760): bandpass to the SSB voice
 * band → afftdn FFT denoise → dynaudnorm AGC. Native ffmpeg filters only.
 */
export function buildEamFilter(nrDb: number, nfDb: number): string {
  return [
    `highpass=f=${EAM_HIGHPASS_HZ}`,
    `lowpass=f=${EAM_LOWPASS_HZ}`,
    buildAfftdnFilter(nrDb, nfDb),
    'dynaudnorm',
  ].join(',');
}

/**
 * Characters that have meaning inside an ffmpeg filtergraph (option
 * `:`/`=`, filter `,`, chain `;`, link `[]`, quoting `'`/`"`/`\`,
 * whitespace). A model path containing any of these would break
 * ffmpeg's filter parser even though the argv itself is shell-safe
 * (we spawn with an args array, not a shell). RNNoise model paths are
 * plain filesystem paths (e.g. `/opt/models/sh.rnnn`), so we reject
 * anything else rather than attempt ffmpeg's two-level escaping.
 */
const FILTERGRAPH_UNSAFE = /[\s:,;=[\]'"\\]/;

export class RnnoiseModelPathUnsafe extends Error {
  constructor(modelPath: string) {
    super(
      `denoise: NOISE_REDUCTION_RNNOISE_MODEL contains characters unsafe for an ffmpeg filtergraph (whitespace : , ; = [ ] ' " \\): ${JSON.stringify(modelPath)}`,
    );
    this.name = 'RnnoiseModelPathUnsafe';
  }
}

/**
 * Builds the ffmpeg `-af arnndn=m=<model>` filter expression for
 * RNNoise (#476). The model path is operator-supplied; ffmpeg loads
 * the `.rnnn` weights and applies the network. Throws
 * `RnnoiseModelPathUnsafe` (fail closed) if the path contains
 * filtergraph-special characters. Exposed for tests.
 */
export function buildArnndnFilter(modelPath: string): string {
  if (FILTERGRAPH_UNSAFE.test(modelPath)) {
    throw new RnnoiseModelPathUnsafe(modelPath);
  }
  return `arnndn=m=${modelPath}`;
}

/**
 * Runs the configured denoise mode against `inputPath`,
 * producing `outputPath`. Resolves with the mode used + nr/nf
 * applied (null for `off` mode) + captured stderr tail.
 *
 * Mode dispatch:
 *   - `off`     → `copyFile(input, output)`. No shell-out.
 *   - `afftdn`  → ffmpeg `-af afftdn=...` (symmetric `-y -loglevel
 *                 error -i input -af ... output` invocation; same
 *                 UTF-8-safe stderr capture as #49/#50).
 *   - `rnnoise` → ffmpeg `-af arnndn=m=<model>` (#476). Throws
 *                 `RnnoiseModelMissing` if no model path is set
 *                 (fail closed); a build without `arnndn` surfaces
 *                 as a `DenoiseError` on the non-zero exit.
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

  const ffmpegBinary = opts.ffmpegBinary ?? DEFAULT_FFMPEG_BINARY;
  const spawnFn = opts.spawnFn ?? spawn;

  // Build the per-mode ffmpeg `-af` filter + the nr/nf reported on the
  // result. afftdn carries nr/nf; rnnoise (arnndn) carries neither (null).
  let filter: string;
  let resultNrDb: number | null;
  let resultNfDb: number | null;
  if (mode === 'rnnoise') {
    const modelPath = opts.rnnoiseModelPath;
    if (typeof modelPath !== 'string' || modelPath.length === 0) {
      // Fail closed — never silently downgrade to afftdn/off (#476).
      throw new RnnoiseModelMissing();
    }
    filter = buildArnndnFilter(modelPath);
    resultNrDb = null;
    resultNfDb = null;
  } else {
    resultNrDb = opts.nrDb ?? DEFAULT_NR_DB;
    resultNfDb = opts.nfDb ?? DEFAULT_NF_DB;
    // `eam` wraps afftdn in the HF bandpass + AGC chain (#760); plain
    // `afftdn` stays the bare filter.
    filter =
      mode === 'eam'
        ? buildEamFilter(resultNrDb, resultNfDb)
        : buildAfftdnFilter(resultNrDb, resultNfDb);
  }

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
          mode,
          nrDb: resultNrDb,
          nfDb: resultNfDb,
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
