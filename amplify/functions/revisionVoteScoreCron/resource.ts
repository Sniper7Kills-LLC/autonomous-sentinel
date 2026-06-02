import { defineFunction } from '@aws-amplify/backend';

/**
 * `revisionVoteScoreCron` — scheduled EventBridge cron that recomputes
 * `TranscriptRevision.voteScore` from the live `RevisionVote` rows (#653).
 *
 * `castRevisionVote` snapshots each voter's `weightAtVoteTime` but does not
 * recompute the parent revision's aggregate score. A DDB-stream consumer
 * would close a CloudFormation circular dependency (the RevisionVote table
 * carries the `castRevisionVote` resolver — see the reverted #658/#661), so
 * the recompute runs on a schedule instead.
 *
 * Strategy (see handler.ts): Scan RevisionVote in pages, sum each revision's
 * weighted votes (UP +weight, DOWN -weight), and `UpdateItem` the parent
 * `TranscriptRevision.voteScore` + `updatedAt`. Raw DynamoDB only (Scan +
 * UpdateItem) — no `allow.resource`/AppSync edge — so it is cycle-safe by
 * construction, mirroring `fieldVoteOrphanJanitor`.
 *
 * `resourceGroupName: 'data'` keeps the Lambda + its IAM grants inside the
 * data stack (intra-stack table refs, no cross-stack token — #317).
 */
export const revisionVoteScoreCron = defineFunction({
  name: 'revisionVoteScoreCron',
  entry: './handler.ts',
  timeoutSeconds: 120,
  memoryMB: 256,
  resourceGroupName: 'data',
});
