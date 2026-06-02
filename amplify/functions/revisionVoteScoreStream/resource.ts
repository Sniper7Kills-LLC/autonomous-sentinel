import { defineFunction } from '@aws-amplify/backend';

/**
 * `revisionVoteScoreStream` — DynamoDB-stream consumer on the
 * RevisionVote table (#653).
 *
 * `castRevisionVote` snapshots each voter's `weightAtVoteTime` but
 * nothing recomputed the parent `TranscriptRevision.voteScore`, so
 * casting a vote never changed the displayed score. This Lambda closes
 * that gap: on every INSERT / MODIFY / REMOVE it re-derives the affected
 * revision's score from the live RevisionVote rows (UP = +weight,
 * DOWN = -weight) and writes it back to `TranscriptRevision.voteScore`
 * via the Amplify Data IAM client.
 *
 * Wiring lives in `amplify/backend.ts` (DynamoDB stream + EventSourceMapping
 * + stream-read IAM). RevisionVote.list + TranscriptRevision.update go
 * through the Amplify Data client granted by `allow.resource(...)` in
 * `data/resource.ts` — using the client (not raw DDB) means `voteScore`
 * writes also stamp `updatedAt` and fire the AppSync subscription.
 *
 * `resourceGroupName: 'data'` keeps the Lambda in the data stack so the
 * table-stream → Lambda edge stays in-stack — same circular-dependency
 * avoidance as `linguisticConfigStream` / `legacyClaimWorker` (#317).
 */
export const revisionVoteScoreStream = defineFunction({
  name: 'revisionVoteScoreStream',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 256,
  resourceGroupName: 'data',
});
