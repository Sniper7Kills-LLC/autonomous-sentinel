/**
 * Type declarations for `transcription-confidence.mjs` (#581).
 * Hand-maintained because the runtime file ships as plain JS into the
 * container image.
 *
 * Source of truth: `transcription-confidence.mjs`. Keep in sync.
 */

/**
 * Mean per-token whisper.cpp probability `p` over content tokens, or
 * `null` when no finite `p` is present. Never throws.
 */
export function extractTranscriptionConfidence(jsonString: string): number | null;
