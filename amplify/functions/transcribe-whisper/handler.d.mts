/**
 * Type declarations for `handler.mjs` (the whisper container Lambda).
 * Hand-maintained because the runtime file ships as plain JS into the
 * container image. Source of truth: `handler.mjs`. Keep in sync.
 *
 * Only the unit-testable surface is declared (#587 added
 * `normalizeMessages`); the Lambda runtime entrypoint `handler` is
 * declared loosely since it is invoked by AWS, not by typed callers.
 */

/** A parsed dispatch/transcribe message body. Loose by design. */
export interface WhisperMessage {
  recordingId: string;
  originalKey?: string;
  audioKey?: string;
  backendOverride?: string;
  enqueuedAt?: string;
  [key: string]: unknown;
}

/**
 * Normalizes the Lambda event into a flat list of message bodies.
 * Accepts both the legacy SQS event shape (`{ Records: [{ body }] }`)
 * and a direct dispatch payload (`{ recordingId, … }`, #587).
 */
export function normalizeMessages(event: unknown): WhisperMessage[];

/** Lambda entrypoint. */
export function handler(event: unknown): Promise<{ ok: true }>;
