/**
 * Type declarations for `run-whisper.mjs`. Hand-maintained because
 * the runtime file ships as plain JS into the container image
 * (no TS build step inside the image — keeps the Dockerfile + the
 * runtime artifact identical to the on-disk source).
 *
 * Source of truth: `run-whisper.mjs`. Keep these signatures in
 * sync with that file when adding fields.
 */

import type { spawn } from 'node:child_process';

export const DEFAULT_WHISPER_BINARY: string;
export const DEFAULT_WHISPER_MODEL_PATH: string;
export const DEFAULT_WHISPER_LANGUAGE: string;
export const DEFAULT_WHISPER_THREADS: number;
export const DEFAULT_STDERR_CAPTURE_BYTES: number;
export const DEFAULT_WHISPER_INITIAL_PROMPT: string;
export const DEFAULT_WHISPER_BEAM_SIZE: number;
export const DEFAULT_WHISPER_TEMPERATURE: number;

export class WhisperError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  readonly signal: string | null;
  constructor(message: string, code: number | null, stderr: string, signal?: string | null);
}

export interface BuildArgsOpts {
  inputPath: string;
  outputPrefix: string;
  language: string;
  threads: number;
  modelPath: string;
  initialPrompt?: string;
  beamSize?: number;
  temperature?: number;
  entropyThold?: number;
  logprobThold?: number;
}

export function buildArgs(opts: BuildArgsOpts): string[];

export interface WhisperConfig {
  whisperBinary: string;
  modelPath: string;
  language: string;
  threads: number;
  initialPrompt: string;
  beamSize: number;
  temperature: number;
  entropyThold: number | undefined;
  logprobThold: number | undefined;
}

export function readWhisperConfig(env?: Record<string, string | undefined>): WhisperConfig;

export interface RunWhisperOpts {
  inputPath: string;
  outputPrefix: string;
  language?: string;
  threads?: number;
  whisperBinary?: string;
  modelPath?: string;
  initialPrompt?: string;
  beamSize?: number;
  temperature?: number;
  entropyThold?: number;
  logprobThold?: number;
  spawnFn?: typeof spawn;
}

export interface RunWhisperResult {
  inputPath: string;
  outputPrefix: string;
  jsonOutputPath: string;
  language: string;
  threads: number;
  modelPath: string;
  stderrTail: string;
}

export function runWhisper(opts: RunWhisperOpts): Promise<RunWhisperResult>;
