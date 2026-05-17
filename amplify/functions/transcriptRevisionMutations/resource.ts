import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda-backed AppSync resolver for TranscriptRevision custom
 * mutations (#287 / #34). Dispatches:
 *   - `submitTranscriptRevision` — gated to
 *     `Recording.transcriptionFailed=true`.
 *   - `acceptTranscriptRevision` — admin/mod; cascades
 *     superseded=true + rewrites Recording.transcript + audit.
 *
 * Schema wiring lives in `amplify/data/resource.ts`; IAM grant
 * is `allow.resource(transcriptRevisionMutations).to(['query', 'mutate'])`.
 */
export const transcriptRevisionMutations = defineFunction({
  name: 'transcriptRevisionMutations',
  entry: './handler.ts',
  timeoutSeconds: 20,
  memoryMB: 256,
});
