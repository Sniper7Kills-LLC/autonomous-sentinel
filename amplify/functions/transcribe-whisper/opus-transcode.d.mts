/**
 * Type declarations for `opus-transcode.mjs` (#514). Hand-maintained
 * because the runtime file ships as plain JS into the container image.
 *
 * Source of truth: `opus-transcode.mjs`. Keep these signatures in sync.
 */

import type { spawn } from 'node:child_process';

export const OPUS_BITRATE: string;
export const OPUS_CHANNELS: number;
export const OPUS_SAMPLE_RATE_HZ: number;
export const OPUS_APPLICATION: string;
export const DEFAULT_FFMPEG_PATH: string;

export class TranscodeError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string);
}

export const WHISPER_SAMPLE_RATE_HZ: number;

export function buildFfmpegArgs(inputPath: string, outputPath: string): string[];
export function buildWavArgs(inputPath: string, outputPath: string): string[];

export interface TranscodeOpts {
  inputPath: string;
  outputPath: string;
  ffmpegPath?: string;
  spawnFn?: typeof spawn;
}

export interface TranscodeResult {
  outputPath: string;
  stderrTail: string;
}

export function transcodeToOpus(opts: TranscodeOpts): Promise<TranscodeResult>;
export function transcodeToWav(opts: TranscodeOpts): Promise<TranscodeResult>;
