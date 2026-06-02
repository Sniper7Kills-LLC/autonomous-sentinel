import { defineFunction } from '@aws-amplify/backend';

/**
 * `costSnapshotTrigger` — admin on-demand cost-snapshot kick-off (#303).
 *
 * Backs the `runCostSnapshotNow` AppSync mutation. On invoke it emits a
 * single EventBridge custom event (`eam.admin` /
 * `CostSnapshotManualSync`) to the default bus and returns immediately
 * (`{ status: 'queued' }`). A Rule on the costSnapshotWorker's own stack
 * matches that event and runs the worker — so the snapshot happens
 * fire-and-forget, ~seconds later.
 *
 * Why a SEPARATE tiny Lambda (not the worker itself):
 *   Binding the worker as the resolver put it in the data
 *   FunctionDirectiveStack AND it carries the EventBridge cron Rule +
 *   IAM in backend.ts → a CloudFormation circular dependency
 *   (FunctionDirectiveStack ↔ data stack; deploy 174/175 FAILED). This
 *   trigger references NOTHING about the worker — it only holds an
 *   `events:PutEvents` grant — so the resolver→trigger edge and the
 *   worker→Rule edge never cross stacks. See backend.ts for the
 *   matching Rule + the cycle-break rationale.
 *
 * Deliberately NOT `resourceGroupName: 'data'`: it touches no DynamoDB
 * table and must not pick up any data-stack reference to the worker.
 * 15 s / 128 MB is ample for a single PutEvents call.
 */
export const costSnapshotTrigger = defineFunction({
  name: 'costSnapshotTrigger',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 128,
});
