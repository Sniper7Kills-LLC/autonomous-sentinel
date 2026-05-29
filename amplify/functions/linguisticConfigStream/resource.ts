import { defineFunction } from '@aws-amplify/backend';

/**
 * `linguisticConfigStream` — DynamoDB-stream consumer on the
 * LinguisticConfig table (#481).
 *
 * Two behaviours (see `handler.ts`): emit a `LINGUISTIC_CONFIG_UPDATE`
 * AuditLog row on every change, and on a `*_PROMPT_VERSION` bump enqueue
 * reprocess jobs for previously-failed Recordings.
 *
 * Wiring lives in `amplify/backend.ts`:
 *   - DynamoEventSource on the LinguisticConfig table stream
 *   - `REPROCESS_QUEUE_URL` (env) + `sqs:SendMessage*` on that queue
 *   - AppSync read (Recording.list) + AuditLog.create via Amplify Data
 *     IAM (granted through the schema's `allow.resource(...)` block)
 *
 * `resourceGroupName: 'data'` keeps the Lambda in the data stack so the
 * table-stream → Lambda edge stays in-stack — same circular-dependency
 * avoidance as `legacyClaimWorker` (#317).
 */
export const linguisticConfigStream = defineFunction({
  name: 'linguisticConfigStream',
  entry: './handler.ts',
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: 'data',
});
