import { defineFunction } from '@aws-amplify/backend';

/**
 * `costSnapshotWorker` — daily 05:00 UTC EventBridge cron that snapshots
 * AWS spend for the public `/transparency` page (#303).
 *
 * Each run pulls three sources (each defensive — one failing logs +
 * continues, never crashes the whole run):
 *   - Cost Explorer `GetCostAndUsage` (DAILY, GroupBy=SERVICE, last 24h)
 *     → one CostSnapshot row per AWS service (category AWS_SERVICE).
 *   - CloudWatch `GetMetricData` (Lambda Invocations + Duration)
 *     → one row per function (category LAMBDA_FUNCTION).
 *   - S3 `ListBucket` over known prefixes → one row per prefix size +
 *     object count (category S3_PREFIX).
 *
 * Writes rows directly to the CostSnapshot table via the DDB SDK
 * (table name from `COST_SNAPSHOT_TABLE_NAME` env). Schedule + scoped
 * IAM grants are wired in `amplify/backend.ts`.
 *
 * 60 s timeout covers three AWS API round-trips + the batched DDB
 * writes; 256 MB matches the other workers.
 */
export const costSnapshotWorker = defineFunction({
  name: 'costSnapshotWorker',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 256,
  // DDB BatchWriteItem on CostSnapshot — grouped with `data` to break
  // the function ↔ auth ↔ data nested-stack circular dependency (#317),
  // same rationale as legacyClaimWorker / fieldVoteOrphanJanitor.
  resourceGroupName: 'data',
});
