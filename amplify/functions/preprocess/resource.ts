import { defineFunction } from '@aws-amplify/backend';

/**
 * Pre-process Lambda.
 *
 * Triggered on S3 object-create in recordings/originals/.
 * Responsibilities (per CLAUDE.md):
 *   - silence trim, voice activity detection, noise reduction
 *   - transcode to web canonical (Opus 32 kbps mono) → recordings/web/{id}.opus
 *   - pipeline temp files in pipeline-temp/ (auto-expire after 7 days)
 *   - emit event for transcribe Lambda when done
 */
export const preprocess = defineFunction({
  name: 'preprocess',
  entry: './handler.ts',
  timeoutSeconds: 300,
  memoryMB: 1024,
});
