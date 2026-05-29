/**
 * In-container ffmpeg → Opus transcode (#514).
 *
 * Runs inside the Whisper container image (which now bundles a static
 * ffmpeg at `/usr/local/bin/ffmpeg`). Produces the web-canonical
 * playback derivative: Opus 32 kbps mono, 16 kHz, VoIP — the same
 * encoding params as the TS `preprocess/opus-transcode.ts`, kept in
 * sync deliberately.
 *
 * `spawnFn` is injectable so the unit test drives argv + exit handling
 * without a real ffmpeg.
 */
import { spawn } from 'node:child_process';

export const OPUS_BITRATE = '32k';
export const OPUS_CHANNELS = 1;
export const OPUS_SAMPLE_RATE_HZ = 16000;
export const OPUS_APPLICATION = 'voip';
export const DEFAULT_FFMPEG_PATH = '/usr/local/bin/ffmpeg';

export class TranscodeError extends Error {
  constructor(message, code, stderr) {
    super(message);
    this.name = 'TranscodeError';
    this.code = code;
    this.stderr = stderr;
  }
}

/** whisper.cpp requires 16 kHz mono signed-16 PCM WAV. */
export const WHISPER_SAMPLE_RATE_HZ = 16000;

export function buildWavArgs(inputPath, outputPath) {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-ac',
    '1',
    '-ar',
    String(WHISPER_SAMPLE_RATE_HZ),
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
}

export function buildFfmpegArgs(inputPath, outputPath) {
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

function runFfmpeg(label, opts, buildArgs) {
  const inputPath = opts?.inputPath;
  const outputPath = opts?.outputPath;
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return Promise.reject(new Error(`${label}: inputPath required`));
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    return Promise.reject(new Error(`${label}: outputPath required`));
  }
  if (inputPath === outputPath) {
    return Promise.reject(new Error(`${label}: inputPath and outputPath must differ`));
  }
  const ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || DEFAULT_FFMPEG_PATH;
  const spawnFn = opts.spawnFn || spawn;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(ffmpegPath, buildArgs(inputPath, outputPath));
    } catch (err) {
      reject(err);
      return;
    }
    // Keep only the tail so a noisy ffmpeg can't grow this unbounded.
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ outputPath, stderrTail: stderr.slice(-512) });
      } else {
        reject(new TranscodeError(`${label}: ffmpeg exited ${code}`, code, stderr.slice(-512)));
      }
    });
  });
}

/** Transcode to the web-canonical Opus (browser playback). */
export function transcodeToOpus(opts) {
  return runFfmpeg('transcodeToOpus', opts, buildFfmpegArgs);
}

/** Transcode to 16 kHz mono PCM WAV — the input whisper.cpp requires. */
export function transcodeToWav(opts) {
  return runFfmpeg('transcodeToWav', opts, buildWavArgs);
}
