import { defineFunction } from '@aws-amplify/backend';

/**
 * `federatedUserSync` — ensures the `User` + `Reputation` shadow rows exist for
 * external-IdP (Google / Discord) sign-ins (#783).
 *
 * PostConfirmation does not fire for federated users, so the native-signup
 * creator never runs for them. The `postAuthentication` trigger publishes a
 * sync job to an SQS queue on each federated sign-in; this worker consumes it
 * and idempotently creates the rows (create-if-absent), seeding the public
 * profile from the verified IdP attributes.
 *
 * `resourceGroupName: 'data'` places it INSIDE the data stack so its
 * DynamoDB grants on the User + Reputation tables are intra-stack — the same
 * cycle-safe pattern as `legacyClaimWorker` / `wafSync` (#317). It reads/writes
 * via the raw DynamoDB SDK (no Amplify Data client), so there is no
 * `allow.resource` data→function edge. Queue subscription + table IAM +
 * table-name env vars are wired in `amplify/backend.ts`.
 */
export const federatedUserSync = defineFunction({
  name: 'federatedUserSync',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  resourceGroupName: 'data',
});
