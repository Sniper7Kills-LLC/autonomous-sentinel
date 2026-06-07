import { defineFunction } from '@aws-amplify/backend';

/**
 * `chartAggregator` — full stats recompute / backfill (#780).
 *
 * Runs on a nightly **EventBridge schedule**: a full Scan of the Message table
 * → absolute `ChartAggregate` counts (overwrite + prune). This seeds existing
 * rows, corrects any drift, and catches Message writes that don't flow through
 * the inline path (model-CRUD admin edits, the future SDR pipeline).
 *
 * The *event-driven* per-write updates (create / soft-delete) are applied
 * INLINE inside the `messageMutations` resolver via the shared `diffOps` +
 * `applyDeltasWith` (atomic `ADD`). A DynamoDB stream on the Message table was
 * deliberately AVOIDED: Message carries custom mutation resolvers, and a stream
 * consumer on a resolver-bearing table closes a CFN cycle that sandbox can't
 * catch (broke prod, reverted #658/#661 — the same reason `revisionVoteScoreCron`
 * is a cron, not a stream). Inline-in-the-resolver is the cycle-safe pattern.
 *
 * `resourceGroupName: 'data'` places the Lambda INSIDE the data stack — the
 * proven cycle-safe pattern used by `wafSync` / `revisionVoteScoreCron` /
 * `costSnapshotWorker` (#317). The Message + ChartAggregate tables live in the
 * data stack, so the schedule Rule + table IAM are INTRA-stack. The handler
 * reads/writes via the raw DynamoDB SDK, never the Amplify Data client, so
 * there is no `allow.resource` data→function edge either.
 *
 * (The handler still supports a DynamoDB-stream event shape — harmless + tested
 * — so a future, proven-safe stream wiring could reuse it without changes.)
 */
export const chartAggregator = defineFunction({
  name: 'chartAggregator',
  entry: './handler.ts',
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: 'data',
});
