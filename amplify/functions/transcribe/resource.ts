import { defineFunction } from '@aws-amplify/backend';

/**
 * Transcribe Lambda.
 *
 * Pluggable backend (env-wide admin default + per-recording override):
 *   - Self-hosted Whisper (container Lambda, model: medium)
 *   - OpenAI hosted Whisper API
 *   - Amazon Transcribe (custom-vocab w/ callsigns)
 *   - Bedrock multimodal (audio-in models)
 *
 * Behavior:
 *   - language hint = en
 *   - chunk audio > 5 min into 5-min segments, transcribe each, stitch
 *   - emit word-level timestamps for scrub-to-text sync
 *   - tolerate cold start (no provisioned concurrency)
 *
 * Note: this `defineFunction` covers the orchestrator. The Whisper container
 * itself will be a separate construct (Docker image Lambda) wired in `backend.ts`.
 */
export const transcribe = defineFunction({
  name: 'transcribe',
  entry: './handler.ts',
  timeoutSeconds: 900,
  memoryMB: 2048,
});
