import type { SQSHandler } from 'aws-lambda';
import {
  ensureFederatedUser,
  type FederatedUserStore,
  type FederatedIdentityInput,
} from './ensure';

/**
 * federatedUserSync worker (#783).
 *
 * Consumes the federated-user-sync SQS queue (one job per federated sign-in,
 * published by the `postAuthentication` trigger) and idempotently ensures the
 * `User` + `Reputation` rows exist. Errors throw so SQS retries / DLQs the
 * message; the ensure is idempotent, so redelivery is safe.
 *
 * The store is injectable for unit tests; the default raw-DynamoDB adapter is
 * loaded lazily so importing this module in a test never pulls the AWS SDK.
 */

interface Deps {
  store?: FederatedUserStore;
}
let injected: Deps = {};
export function __setStore(store: FederatedUserStore | undefined): void {
  injected = store ? { store } : {};
}

let cachedStore: FederatedUserStore | undefined;
async function getStore(): Promise<FederatedUserStore> {
  if (injected.store) return injected.store;
  if (!cachedStore) {
    const mod = await import('./store');
    cachedStore = mod.createDynamoUserStore();
  }
  return cachedStore;
}

/** Parse + validate a queue message body into a sync payload, or null. */
export function parseJob(body: string): FederatedIdentityInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.cognitoSub !== 'string' || !p.cognitoSub) return null;
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    cognitoSub: p.cognitoSub,
    email: s(p.email),
    displayName: s(p.displayName),
    preferredUsername: s(p.preferredUsername),
  };
}

export const handler: SQSHandler = async (event, _context, _callback) => {
  const store = await getStore();
  for (const record of event.Records) {
    const job = parseJob(record.body);
    if (!job) {
      console.warn('federatedUserSync: skipping unparseable job', { messageId: record.messageId });
      continue;
    }
    const outcome = await ensureFederatedUser(store, job);
    console.info('federatedUserSync: ensured', { cognitoSub: job.cognitoSub, outcome });
  }
};
