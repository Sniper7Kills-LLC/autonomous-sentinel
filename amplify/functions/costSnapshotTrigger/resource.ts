import { defineFunction } from '@aws-amplify/backend';

/**
 * `costSnapshotTrigger` — the AppSync resolver behind the admin
 * `runCostSnapshotNow` mutation (#644).
 *
 * On-demand cost-sync is decoupled from the worker via SQS. The worker
 * (`costSnapshotWorker`) cannot be both an AppSync resolver and a cron
 * target in this stack: binding it as a resolver puts it in the
 * FunctionDirectiveStack, which closes a CloudFormation circular
 * dependency against the data stack (proven across 6 failed deploys).
 *
 * Instead this tiny trigger IS the resolver and does exactly ONE thing:
 * `sqs:SendMessage` to the cost-snapshot queue (URL from the
 * `COST_SNAPSHOT_QUEUE_URL` env var). The worker consumes that queue as
 * an SQS event source — an event source, NOT a resolver — so it never
 * enters the FunctionDirectiveStack. The trigger references nothing
 * about the worker (no ARN, no name); it only knows the queue URL. This
 * mirrors the proven `postConfirmation → legacyClaimQueue → legacyClaimWorker`
 * SQS hand-off.
 *
 * Grouped with `data` (same rationale as the other AppSync-backed
 * mutation Lambdas) to keep the function ↔ auth ↔ data nested-stack
 * graph acyclic (#317).
 */
export const costSnapshotTrigger = defineFunction({
  name: 'costSnapshotTrigger',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
  resourceGroupName: 'data',
});
