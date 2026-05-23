import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';

/**
 * Opus transcode helper for the pre-process Lambda (#52).
 *
 * Final pre-process stage. Reads the denoised WAV from #51 and
 * encodes the canonical web playback derivative: Opus 32 kbps
 * mono in an OGG container. Per CLAUDE.md → Storage / retention:
 * "Web canonical — Opus 32 kbps mono (`.opus` in OGG container)
 * used for browser playback. Voice-optimized; ~250 KB per 60s".
 *
 * Encoding parameters are HARD-CODED (not env-tunable) — "canonical
 * means canonical". A future bitrate / sample-rate change is a
 * data-migration concern, not an env flip. From #52 spec:
 *
 *   - bitrate: 32 kbps
 *   - channels: 1 (mono downmix)
 *   - sample rate: 16 kHz (transparent for voice at 32k)
 *   - application: voip (libopus speech-tuning mode)
 *   - vbr: on
 *
 * Same shell-out shape + UTF-8-safe stderr capture as #49 /
 * #50 / #51. Injectable `spawnFn` test seam. Pure JS; the
 * deferred handler does the S3 PUT + Recording row update.
 *
 * Output container chosen as OGG (default for `.opus`
 * extension); ffmpeg picks it automatically when the output
 * path ends in `.opus`.
 */

export const OPUS_BITRATE = '32k';
export const OPUS_CHANNELS = 1;
export const OPUS_SAMPLE_RATE_HZ = 16_000;
export const OPUS_APPLICATION = 'voip';
export const DEFAULT_FFMPEG_BINARY = 'ffmpeg';
export const DEFAULT_STDERR_CAPTURE_BYTES = 4096;

export interface TranscodeOpusOpts {
  inputPath: string;
  outputPath: string;
  ffmpegBinary?: string;
  spawnFn?: typeof spawn;
}

export interface TranscodeOpusResult {
  inputPath: string;
  outputPath: string;
  bitrate: string;
  channels: number;
  sampleRateHz: number;
  application: string;
  stderrTail: string;
}

export class TranscodeOpusError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = 'TranscodeOpusError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Builds the ffmpeg argv for Opus transcode. Exposed for tests
 * so the canonical encoding parameters are pinnable.
 */
export function buildArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-c:a',
    'libopus',
    '-b:a',
    OPUS_BITRATE,
    '-ac',
    String(OPUS_CHANNELS),
    '-ar',
    String(OPUS_SAMPLE_RATE_HZ),
    '-application',
    OPUS_APPLICATION,
    '-vbr',
    'on',
    outputPath,
  ];
}

/**
 * Transcodes the denoised input to Opus 32 kbps mono.
 * Promise resolves with the canonical encoding parameters +
 * captured stderr tail on exit code 0; rejects with
 * `TranscodeOpusError` on any other code or spawn failure.
 */
export function transcodeOpus(opts: TranscodeOpusOpts): Promise<TranscodeOpusResult> {
  if (typeof opts.inputPath !== 'string' || opts.inputPath.length === 0) {
    return Promise.reject(new Error('transcodeOpus: inputPath required'));
  }
  if (typeof opts.outputPath !== 'string' || opts.outputPath.length === 0) {
    return Promise.reject(new Error('transcodeOpus: outputPath required'));
  }
  if (opts.inputPath === opts.outputPath) {
    return Promise.reject(new Error('transcodeOpus: inputPath and outputPath must differ'));
  }

  const ffmpegBinary = opts.ffmpegBinary ?? DEFAULT_FFMPEG_BINARY;
  const spawnFn = opts.spawnFn ?? spawn;
  const args = buildArgs(opts.inputPath, opts.outputPath);

  return new Promise<TranscodeOpusResult>((resolve, reject) => {
    let child;
    const spawnOpts: SpawnOptions = { stdio: ['ignore', 'ignore', 'pipe'] };
    try {
      child = spawnFn(ffmpegBinary, args, spawnOpts);
    } catch (err) {
      reject(
        new TranscodeOpusError(
          `transcodeOpus: spawn failed: ${err instanceof Error ? err.message : String(err)}`,
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
      reject(new TranscodeOpusError(`transcodeOpus: spawn error: ${err.message}`, null, decode()));
    });

    child.once('close', (code: number | null) => {
      if (code === 0) {
        resolve({
          inputPath: opts.inputPath,
          outputPath: opts.outputPath,
          bitrate: OPUS_BITRATE,
          channels: OPUS_CHANNELS,
          sampleRateHz: OPUS_SAMPLE_RATE_HZ,
          application: OPUS_APPLICATION,
          stderrTail: decode(),
        });
        return;
      }
      reject(
        new TranscodeOpusError(
          `transcodeOpus: ffmpeg exited with code ${code ?? 'null'}`,
          code,
          decode(),
        ),
      );
    });
  });
}

/**
 * S3 metadata for a freshly transcoded Opus file. The deferred
 * handler uses this when writing the canonical playback file to
 * `recordings/web/{recordingId}.opus` per #46. Exposed here so
 * the contentType + cache-control don't drift across consumers.
 */
export const WEB_CANONICAL_S3_METADATA = {
  contentType: 'audio/ogg; codecs=opus',
  cacheControl: 'public, max-age=31536000, immutable',
} as const;

export function webCanonicalKey(recordingId: string): string {
  if (typeof recordingId !== 'string' || recordingId.length === 0) {
    throw new Error('webCanonicalKey: recordingId required');
  }
  return `recordings/web/${recordingId}.opus`;
}
