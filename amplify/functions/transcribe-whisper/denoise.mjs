/**
 * In-container noise-reduction (#671 — folds the #51 DSP stage into the
 * Whisper image).
 *
 * Reads the silence-trimmed audio and optionally applies frequency-domain
 * denoising before the VAD + transcode stages. Runtime `.mjs` copy of
 * `preprocess/denoise.ts` — kept in sync deliberately.
 *
 * Mode switch (`NOISE_REDUCTION_MODE` env):
 *   - `'off'`     — byte-identical file copy. Used in dev so denoising
 *                   can't mask a real audio defect while reproducing a
 *                   transcript bug.
 *   - `'afftdn'`  — ffmpeg `afftdn=nr=<nrDb>:nf=<nfDb>` filter. Prod default.
 *   - `'rnnoise'` — throws `RnnoiseNotImplemented` until the RNNoise WASM
 *                   layer ships behind a feature flag (#476).
 *
 * `spawnFn` + `copyFileFn` injectable so the unit test never shells out
 * / touches the real filesystem.
 */
import { copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const NOISE_REDUCTION_MODES = ['off', 'afftdn', 'eam', 'rnnoise'];
// `eam` (#760): HF-SSB-tuned chain — bandpass to the 300–3000 Hz voice band
// (drops sub-rumble + high-freq hiss outside speech), afftdn FFT denoise, then
// dynaudnorm AGC to even out fading. Raises SNR for ASR on noisy shortwave.
// All native ffmpeg filters — no RNNoise WASM dependency.
export const DEFAULT_NOISE_REDUCTION_MODE = 'eam';
export const DEFAULT_NR_DB = 12;
export const DEFAULT_NF_DB = -25;
export const DEFAULT_FFMPEG_PATH = '/usr/local/bin/ffmpeg';
export const DEFAULT_STDERR_CAPTURE_BYTES = 4096;

export class DenoiseError extends Error {
  constructor(message, code, stderr) {
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

export function isNoiseReductionMode(value) {
  return typeof value === 'string' && NOISE_REDUCTION_MODES.includes(value);
}

function parseBoundedNumber(raw, fallback, bounds = {}) {
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
 * Reads denoise tunables from env. Unknown mode / out-of-range numbers
 * fall back to defaults + warn so a fat-finger admin can't break the gate.
 */
export function readDenoiseConfig(env = process.env) {
  const rawMode = env.NOISE_REDUCTION_MODE;
  let mode = DEFAULT_NOISE_REDUCTION_MODE;
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

/** Builds the ffmpeg `-af afftdn=...` expression. Exposed for tests. */
export function buildAfftdnFilter(nrDb, nfDb) {
  return `afftdn=nr=${nrDb}:nf=${nfDb}`;
}

/** HF voice band edges for the `eam` chain (#760). */
export const EAM_HIGHPASS_HZ = 300;
export const EAM_LOWPASS_HZ = 3000;

/**
 * Builds the `eam` HF-voice ffmpeg chain (#760): bandpass to the SSB voice
 * band → afftdn FFT denoise → dynaudnorm AGC. Exposed for tests.
 */
export function buildEamFilter(nrDb, nfDb) {
  return [
    `highpass=f=${EAM_HIGHPASS_HZ}`,
    `lowpass=f=${EAM_LOWPASS_HZ}`,
    buildAfftdnFilter(nrDb, nfDb),
    'dynaudnorm',
  ].join(',');
}

/** Resolve the ffmpeg `-af` filter string for an ffmpeg-backed mode. */
export function filterForMode(mode, nrDb, nfDb) {
  return mode === 'eam' ? buildEamFilter(nrDb, nfDb) : buildAfftdnFilter(nrDb, nfDb);
}

export function buildArgs(inputPath, outputPath, filter) {
  return ['-y', '-loglevel', 'error', '-i', inputPath, '-af', filter, outputPath];
}

/**
 * Runs the configured denoise mode against `inputPath` → `outputPath`.
 *   - off     → copyFile (no shell-out)
 *   - afftdn  → ffmpeg afftdn filter
 *   - rnnoise → throws RnnoiseNotImplemented
 * Throws `DenoiseError` on ffmpeg non-zero exit / spawn failure.
 */
export async function denoise(opts) {
  const inputPath = opts?.inputPath;
  const outputPath = opts?.outputPath;
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error('denoise: inputPath required');
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new Error('denoise: outputPath required');
  }
  if (inputPath === outputPath) {
    // copyFile onto itself truncates; ffmpeg `-i x ... x` re-reads the
    // stream it just overwrote. Either way the input is lost.
    throw new Error('denoise: inputPath and outputPath must differ');
  }
  const mode = opts.mode ?? DEFAULT_NOISE_REDUCTION_MODE;

  if (mode === 'off') {
    const copyFn = opts.copyFileFn || copyFile;
    await copyFn(inputPath, outputPath);
    return { inputPath, outputPath, mode: 'off', nrDb: null, nfDb: null, stderrTail: '' };
  }
  if (mode === 'rnnoise') {
    throw new RnnoiseNotImplemented();
  }

  const nrDb = opts.nrDb ?? DEFAULT_NR_DB;
  const nfDb = opts.nfDb ?? DEFAULT_NF_DB;
  const ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || DEFAULT_FFMPEG_PATH;
  const spawnFn = opts.spawnFn || spawn;
  // `afftdn` and `eam` are both ffmpeg-backed; pick the filter for the mode.
  const args = buildArgs(inputPath, outputPath, filterForMode(mode, nrDb, nfDb));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
      reject(new DenoiseError(`denoise: spawn error: ${err.message}`, null, decode()));
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ inputPath, outputPath, mode, nrDb, nfDb, stderrTail: decode() });
        return;
      }
      reject(
        new DenoiseError(`denoise: ffmpeg exited with code ${code ?? 'null'}`, code, decode()),
      );
    });
  });
}
