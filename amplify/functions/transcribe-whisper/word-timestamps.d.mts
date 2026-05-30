/**
 * Type declarations for `word-timestamps.mjs` (#527). Hand-maintained
 * because the runtime file ships as plain JS into the container image.
 *
 * Source of truth: `word-timestamps.mjs`. Keep these signatures in sync.
 */

export interface WordTimestamp {
  word: string;
  /** Start time, seconds. */
  start: number;
  /** End time, seconds. */
  end: number;
}

export interface WordTimestampsSidecar {
  words: WordTimestamp[];
}

export function extractWordTimestamps(jsonString: string): WordTimestampsSidecar;
