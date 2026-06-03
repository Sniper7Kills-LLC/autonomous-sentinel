/**
 * Type declarations for `vad.mjs` (#671). Hand-maintained because the
 * runtime file ships as plain JS into the container image.
 * Source of truth: `vad.mjs`. Keep these signatures in sync.
 *
 * `VadSegment` mirrors the shape in `_shared/chunk.ts` (#59) so the
 * long-audio chunker + the future more-to-follow splitter share it.
 */
import type { spawn } from 'node:child_process';

export const DEFAULT_VAD_NOISE_DB: number;
export const DEFAULT_VAD_MIN_SILENCE_SEC: number;
export const DEFAULT_FFMPEG_PATH: string;
export const DEFAULT_STDERR_CAPTURE_BYTES: number;

export class VadError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string);
}

export interface VadSegment {
  startMs: number;
  endMs: number;
  isSpeech: boolean;
}

export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

export function readVadConfig(env?: Record<string, string | undefined>): {
  noiseDb: number;
  minSilenceSec: number;
};

export function parseSilenceDetect(stderr: string, totalDurationMs: number): SilenceInterval[];
export function buildSegments(silences: SilenceInterval[], totalDurationMs: number): VadSegment[];
export function summarise(segments: VadSegment[]): { speechMs: number; silenceMs: number };
export function buildArgs(inputPath: string, noiseDb: number, minSilenceSec: number): string[];

export interface VadOpts {
  inputPath: string;
  totalDurationMs: number;
  noiseDb?: number;
  minSilenceSec?: number;
  ffmpegPath?: string;
  spawnFn?: typeof spawn;
}

export interface VadResult {
  segments: VadSegment[];
  speechMs: number;
  silenceMs: number;
}

export function runVad(opts: VadOpts): Promise<VadResult>;
