import type { AppSyncResolverHandler } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

/**
 * `costSnapshotTrigger` — AppSync resolver for the admin
 * `runCostSnapshotNow` mutation (#644).
 *
 * Does exactly ONE thing: enqueue a message on the cost-snapshot SQS
 * queue so the (cron + SQS) `costSnapshotWorker` runs a fresh snapshot
 * out-of-band. It references nothing about the worker — only the queue
 * URL from `COST_SNAPSHOT_QUEUE_URL`. This keeps the worker out of the
 * FunctionDirectiveStack (resolver stack) and avoids the
 * FunctionDirectiveStack ↔ data CloudFormation circular dependency that
 * binding the worker as a resolver would create.
 *
 * Returns `{ status: 'queued' }` immediately; the admin UI polls /
 * refetches the CostSnapshot rows a minute later to see the result.
 */

const QUEUE_URL_ENV = 'COST_SNAPSHOT_QUEUE_URL';

export interface RunCostSnapshotNowResult {
  status: 'queued';
}

let cachedSqs: SQSClient | undefined;
function sqsClient(): SQSClient {
  if (!cachedSqs) cachedSqs = new SQSClient({});
  return cachedSqs;
}

// Test seam — lets the unit test swap the SQS client without touching
// the AWS SDK.
let injectedSqs: SQSClient | undefined;
export function __setSqsClient(client: SQSClient | undefined): void {
  injectedSqs = client;
}

function queueUrl(): string {
  const v = process.env[QUEUE_URL_ENV];
  if (!v) throw new Error(`costSnapshotTrigger: ${QUEUE_URL_ENV} env var is required`);
  return v;
}

// `_context` / `_callback` are declared (unused) so the 3-arg Lambda
// `Handler` call sites in the tests are not flagged as superfluous by
// CodeQL (js/superfluous-trailing-arguments).
export const handler: AppSyncResolverHandler<
  Record<string, never>,
  RunCostSnapshotNowResult
> = async (_event, _context, _callback) => {
  const client = injectedSqs ?? sqsClient();
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl(),
      // `source` mirrors the EventBridge cron marker so the worker's
      // existing shape-detection treats the manual run the same as the
      // scheduled one. The body content is otherwise unused.
      MessageBody: JSON.stringify({ source: 'admin.runCostSnapshotNow', ts: Date.now() }),
    }),
  );
  return { status: 'queued' };
};
