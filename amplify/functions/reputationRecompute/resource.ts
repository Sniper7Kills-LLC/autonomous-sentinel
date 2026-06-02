import { defineFunction } from '@aws-amplify/backend';

/**
 * `reputationRecompute` — DynamoDB-stream consumer that recomputes a
 * user's `Reputation.computedWeight` (#480).
 *
 * Two triggers, both on tables this Lambda subscribes to via the stream
 * (single recompute source):
 *   - Recording → `transcriptionStatus` transitions to `PUBLISHED`
 *     (a validated submission for the uploader).
 *   - TranscriptRevision → `accepted` flips true (an accepted correction
 *     for the proposer).
 *
 * Rather than incrementing counters (not idempotent under at-least-once
 * stream redelivery), it RECOMPUTES FROM SOURCE: counts the user's
 * PUBLISHED recordings + accepted revisions via the generated GSI list
 * queries and writes the absolute weight. Concurrent recomputes converge
 * to the same value, so no CAS is needed.
 *
 * Reads (Recording/TranscriptRevision GSI lists, User role) + the
 * Reputation write all go through the Amplify Data IAM client, granted by
 * `allow.resource(reputationRecompute)` in `data/resource.ts`. The only
 * extra IAM is stream-read on the two table streams (wired in backend.ts).
 *
 * `resourceGroupName: 'data'` keeps the table-stream → Lambda edge inside
 * the data stack (same #317 circular-dependency avoidance as the other
 * stream consumers).
 *
 * Out of scope (tracked): formula-tuning admin UI (#117), Cognito
 * custom-attribute sync (#477), one-time backfill, threshold-crossing
 * audit emit (follow-ups on #480).
 */
export const reputationRecompute = defineFunction({
  name: 'reputationRecompute',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 256,
  resourceGroupName: 'data',
});
