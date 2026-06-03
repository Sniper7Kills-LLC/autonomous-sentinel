/**
 * Type declarations for `silence-trim.mjs` (#671). Hand-maintained
 * because the runtime file ships as plain JS into the container image.
 * Source of truth: `silence-trim.mjs`. Keep these signatures in sync.
 */
import type { spawn } from 'node:child_process';

export const DEFAULT_SILENCE_THRESHOLD_DB: number;
export const DEFAULT_SILENCE_MIN_SEC: number;
export const DEFAULT_FFMPEG_PATH: string;
export const DEFAULT_STDERR_CAPTURE_BYTES: number;

export class SilenceTrimError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string);
}

export function buildFilterChain(thresholdDb: number, minSilenceSec: number): string;

export function readSilenceConfig(env?: Record<string, string | undefined>): {
  thresholdDb: number;
  minSilenceSec: number;
};

export function buildArgs(inputPath: string, outputPath: string, filter: string): string[];

export interface SilenceTrimOpts {
  inputPath: string;
  outputPath: string;
  thresholdDb?: number;
  minSilenceSec?: number;
  ffmpegPath?: string;
  spawnFn?: typeof spawn;
}

export interface SilenceTrimResult {
  inputPath: string;
  outputPath: string;
  thresholdDb: number;
  minSilenceSec: number;
  stderrTail: string;
}

export function silenceTrim(opts: SilenceTrimOpts): Promise<SilenceTrimResult>;
