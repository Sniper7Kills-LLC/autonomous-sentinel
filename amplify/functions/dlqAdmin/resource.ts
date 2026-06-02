import { defineFunction } from '@aws-amplify/backend';

/**
 * `dlqAdmin` — Lambda-backed AppSync resolver for the admin DLQ +
 * manual-reprocess view (#107).
 *
 * Backs three admin-only custom operations declared in
 * `amplify/data/resource.ts`:
 *   - `listDlqMessages(stage)` — query. ReceiveMessage peek (visibility
 *     timeout 0, no delete) on the requested stage's DLQ; returns the
 *     stuck messages with friendly metadata (recordingId, attempt count,
 *     enqueue time, error reason, receipt handle).
 *   - `requeueDlqMessage(stage, receiptHandle, body, recordingId?)` —
 *     mutation. SendMessage the body back onto the stage's PRIMARY queue,
 *     then DeleteMessage it from the DLQ. Emits a `DLQ_REQUEUE` audit row.
 *   - `dropDlqMessage(stage, receiptHandle, recordingId?)` — mutation.
 *     DeleteMessage from the DLQ permanently, mark the Recording
 *     `transcriptionStatus = FAILED` (terminal) when a recordingId is
 *     known, and emit a `DLQ_DROP` audit row.
 *
 * The queue URLs arrive as env vars wired in `backend.ts`
 * (`*_QUEUE_URL` + `*_DLQ_URL` per stage). The Lambda references the
 * neutral `PipelineQueuesStack` queues for `sqs:ReceiveMessage` /
 * `SendMessage` / `DeleteMessage` — a one-way function → queue-stack
 * edge that does not close a CloudFormation cycle. AuditLog + Recording
 * writes go through the Amplify Data client (IAM auth) via the
 * schema-level `allow.resource(dlqAdmin)` grant, mirroring the other
 * mutation resolvers (#317 acyclic nested-stack rule).
 *
 * Grouped with `data` (same rationale as every other AppSync-backed
 * mutation Lambda) to keep the function ↔ auth ↔ data graph acyclic.
 */
export const dlqAdmin = defineFunction({
  name: 'dlqAdmin',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  resourceGroupName: 'data',
});
