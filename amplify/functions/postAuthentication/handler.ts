import type { PostAuthenticationTriggerHandler } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { extractFederatedIdentity } from './federated';
import type { FederatedIdentityInput } from '../federatedUserSync/ensure';

/**
 * Post-Authentication trigger (#783).
 *
 * On a federated sign-in, publishes a sync job so the federatedUserSync worker
 * ensures the User + Reputation rows. Best-effort: any failure is logged and
 * swallowed — sign-in must never be blocked by the row-ensure hand-off (the
 * worker is idempotent and the next sign-in retries). Native sign-ins are a
 * no-op. Always returns the event unchanged.
 */

const sqs = new SQSClient({});

export type Dispatcher = (job: FederatedIdentityInput) => Promise<void>;
let injectedDispatcher: Dispatcher | undefined;
/** Test seam — swap the SQS publisher. */
export function __setDispatcher(fn: Dispatcher | undefined): void {
  injectedDispatcher = fn;
}

async function defaultDispatcher(job: FederatedIdentityInput): Promise<void> {
  const queueUrl = process.env.FEDERATED_SYNC_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('postAuthentication: FEDERATED_SYNC_QUEUE_URL env var is required');
  }
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) }));
}

export const handler: PostAuthenticationTriggerHandler = async (event) => {
  const job = extractFederatedIdentity(event);
  if (!job) return event; // native sign-in (or no sub) — nothing to sync

  const dispatch = injectedDispatcher ?? defaultDispatcher;
  try {
    await dispatch(job);
    console.info('postAuthentication: queued federated user sync', { cognitoSub: job.cognitoSub });
  } catch (err) {
    console.error('postAuthentication: failed to queue federated user sync', err);
  }
  return event;
};
