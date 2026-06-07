/**
 * Type declarations for `denoise.mjs` (#671). Hand-maintained because
 * the runtime file ships as plain JS into the container image.
 * Source of truth: `denoise.mjs`. Keep these signatures in sync.
 */
import type { spawn } from 'node:child_process';
import type { copyFile } from 'node:fs/promises';

export type NoiseReductionMode = 'off' | 'afftdn' | 'eam' | 'rnnoise';

export const NOISE_REDUCTION_MODES: readonly NoiseReductionMode[];
export const DEFAULT_NOISE_REDUCTION_MODE: NoiseReductionMode;
export const DEFAULT_NR_DB: number;
export const DEFAULT_NF_DB: number;
export const DEFAULT_FFMPEG_PATH: string;
export const DEFAULT_STDERR_CAPTURE_BYTES: number;

export class DenoiseError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string);
}

export class RnnoiseNotImplemented extends Error {
  constructor();
}

export function isNoiseReductionMode(value: unknown): value is NoiseReductionMode;

export function readDenoiseConfig(env?: Record<string, string | undefined>): {
  mode: NoiseReductionMode;
  nrDb: number;
  nfDb: number;
};

export const EAM_HIGHPASS_HZ: number;
export const EAM_LOWPASS_HZ: number;
export function buildAfftdnFilter(nrDb: number, nfDb: number): string;
export function buildEamFilter(nrDb: number, nfDb: number): string;
export function filterForMode(mode: NoiseReductionMode, nrDb: number, nfDb: number): string;
export function buildArgs(inputPath: string, outputPath: string, filter: string): string[];

export interface DenoiseOpts {
  inputPath: string;
  outputPath: string;
  mode?: NoiseReductionMode;
  nrDb?: number;
  nfDb?: number;
  ffmpegPath?: string;
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

export function denoise(opts: DenoiseOpts): Promise<DenoiseResult>;
