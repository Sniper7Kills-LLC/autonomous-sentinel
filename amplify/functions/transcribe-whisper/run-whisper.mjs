/**
 * whisper.cpp invocation helper for the Whisper container Lambda
 * (#53). Shells out to the `whisper` binary baked into the image
 * at `/opt/whisper` against the medium English model at
 * `/opt/models/medium.en.bin`.
 *
 * Authored as ESM `.mjs` (not `.ts`) so the in-container handler
 * imports the same file without a build step. JSDoc types keep
 * the editor happy; vitest still type-checks the `.test.ts` file
 * against this module.
 *
 * Output format: `-oj` writes a JSON file next to the audio with
 * per-segment + per-token timestamps. The existing
 * `normalizeWhisperCpp` helper from `_shared/timestamps.ts` (#61)
 * already parses that shape; the deferred finalizer reads the
 * JSON via `readFile` + persists the canonical Transcript.
 *
 * Tunables (env, validated by the handler):
 *   - `WHISPER_BINARY` — default `/opt/whisper`.
 *   - `WHISPER_MODEL_PATH` — default `/opt/models/medium.en.bin`.
 *   - `WHISPER_LANGUAGE` — default `'en'` per CLAUDE.md
 *     ("language hint = en").
 *   - `WHISPER_THREADS` — default `4`. Lambda container at
 *     3008 MB gets ~2 vCPU; oversubscribing to 4 threads keeps
 *     the whisper.cpp pipeline saturated.
 */

import { spawn } from 'node:child_process';

export const DEFAULT_WHISPER_BINARY = '/opt/whisper';
export const DEFAULT_WHISPER_MODEL_PATH = '/opt/models/medium.en.bin';
export const DEFAULT_WHISPER_LANGUAGE = 'en';
export const DEFAULT_WHISPER_THREADS = 4;
export const DEFAULT_STDERR_CAPTURE_BYTES = 8 * 1024;

export class WhisperError extends Error {
  /**
   * @param {string} message
   * @param {number | null} code
   * @param {string} stderr
   */
  constructor(message, code, stderr) {
    super(message);
    this.name = 'WhisperError';
    /** @type {number | null} */
    this.code = code;
    /** @type {string} */
    this.stderr = stderr;
  }
}

/**
 * Builds the whisper.cpp CLI argv. Exposed for tests so the
 * pinned arg shape can be asserted exactly.
 *
 * @param {{ inputPath: string; outputPrefix: string; language: string;
 *          threads: number; modelPath: string }} opts
 * @returns {string[]}
 */
export function buildArgs(opts) {
  // whisper.cpp argv: `-ng -m model -f input -l lang -t threads -oj -of prefix`.
  //
  // `-ng` (#455): disable GPU backend. Lambda runtime has no GPU.
  // whisper.cpp v1.8.x defaults to `use_gpu=1` which probes Vulkan/
  // CUDA/Metal during init; on a CPU-only Lambda this segfaults
  // immediately after model load with `code: null` (signal-killed)
  // and no error message — just silent death. CPU is the only
  // backend available anyway.
  //
  // Note (#450): do NOT add boolean flags with a literal `'false'`
  // / `'true'` follow-up value. whisper.cpp's boolean options
  // (e.g. `--print-progress`) are presence flags — a trailing
  // `'false'` is parsed as a positional input file path and the
  // run fails with `error: input file not found 'false'`.
  return [
    '-ng',
    '-m',
    opts.modelPath,
    '-f',
    opts.inputPath,
    '-l',
    opts.language,
    '-t',
    String(opts.threads),
    '-oj',
    '-of',
    opts.outputPrefix,
  ];
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ whisperBinary: string; modelPath: string; language: string; threads: number }}
 */
export function readWhisperConfig(env = process.env) {
  return {
    whisperBinary: env.WHISPER_BINARY ?? DEFAULT_WHISPER_BINARY,
    modelPath: env.WHISPER_MODEL_PATH ?? DEFAULT_WHISPER_MODEL_PATH,
    language: env.WHISPER_LANGUAGE ?? DEFAULT_WHISPER_LANGUAGE,
    threads: parseThreads(env.WHISPER_THREADS),
  };
}

/**
 * @param {string | undefined} raw
 * @returns {number}
 */
function parseThreads(raw) {
  if (!raw) return DEFAULT_WHISPER_THREADS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    console.warn('whisper: ignoring invalid WHISPER_THREADS env value', {
      raw,
      fallback: DEFAULT_WHISPER_THREADS,
    });
    return DEFAULT_WHISPER_THREADS;
  }
  return n;
}

/**
 * Runs whisper.cpp against the input audio. Promise resolves with
 * the JSON output path + captured stderr tail on exit 0; rejects
 * with `WhisperError(code, stderr)` on any other code or spawn
 * failure.
 *
 * @param {{
 *   inputPath: string;
 *   outputPrefix: string;
 *   language?: string;
 *   threads?: number;
 *   whisperBinary?: string;
 *   modelPath?: string;
 *   spawnFn?: typeof spawn;
 * }} opts
 * @returns {Promise<{
 *   inputPath: string;
 *   outputPrefix: string;
 *   jsonOutputPath: string;
 *   language: string;
 *   threads: number;
 *   modelPath: string;
 *   stderrTail: string;
 * }>}
 */
export function runWhisper(opts) {
  if (typeof opts.inputPath !== 'string' || opts.inputPath.length === 0) {
    return Promise.reject(new Error('runWhisper: inputPath required'));
  }
  if (typeof opts.outputPrefix !== 'string' || opts.outputPrefix.length === 0) {
    return Promise.reject(new Error('runWhisper: outputPrefix required'));
  }
  if (opts.inputPath === opts.outputPrefix) {
    return Promise.reject(new Error('runWhisper: inputPath and outputPrefix must differ'));
  }
  const language = opts.language ?? DEFAULT_WHISPER_LANGUAGE;
  const threads = opts.threads ?? DEFAULT_WHISPER_THREADS;
  const whisperBinary = opts.whisperBinary ?? DEFAULT_WHISPER_BINARY;
  const modelPath = opts.modelPath ?? DEFAULT_WHISPER_MODEL_PATH;
  const spawnFn = opts.spawnFn ?? spawn;
  const args = buildArgs({
    inputPath: opts.inputPath,
    outputPrefix: opts.outputPrefix,
    language,
    threads,
    modelPath,
  });

  return new Promise((resolve, reject) => {
    let child;
    const spawnOpts = { stdio: ['ignore', 'ignore', 'pipe'] };
    try {
      child = spawnFn(whisperBinary, args, spawnOpts);
    } catch (err) {
      reject(
        new WhisperError(
          `runWhisper: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          null,
          '',
        ),
      );
      return;
    }

    let stderrBuf = Buffer.alloc(0);
    const stderr = child.stderr;
    if (stderr) {
      stderr.on('data', (chunk) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        const combined = Buffer.concat([stderrBuf, buf]);
        stderrBuf =
          combined.byteLength > DEFAULT_STDERR_CAPTURE_BYTES
            ? combined.subarray(combined.byteLength - DEFAULT_STDERR_CAPTURE_BYTES)
            : combined;
      });
    }

    const decode = () => stderrBuf.toString('utf8');

    child.once('error', (err) => {
      reject(new WhisperError(`runWhisper: spawn error: ${err.message}`, null, decode()));
    });

    child.once('close', (code) => {
      if (code === 0) {
        resolve({
          inputPath: opts.inputPath,
          outputPrefix: opts.outputPrefix,
          jsonOutputPath: `${opts.outputPrefix}.json`,
          language,
          threads,
          modelPath,
          stderrTail: decode(),
        });
        return;
      }
      reject(
        new WhisperError(
          `runWhisper: whisper.cpp exited with code ${code ?? 'null'}`,
          code,
          decode(),
        ),
      );
    });
  });
}
