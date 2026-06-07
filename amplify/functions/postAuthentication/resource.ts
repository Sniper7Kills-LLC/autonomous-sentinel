import { defineFunction } from '@aws-amplify/backend';

/**
 * Cognito Post-Authentication trigger (#783).
 *
 * Fires on every successful sign-in (native + federated). For federated
 * (external-IdP) sign-ins — which PostConfirmation never covers — it publishes
 * a sync job to the federated-user-sync SQS queue so the `federatedUserSync`
 * worker can ensure the `User` + `Reputation` rows exist. Native sign-ins are
 * ignored (their rows were created by postConfirmation).
 *
 * `resourceGroupName: 'auth'` keeps the trigger inside the auth stack (the User
 * Pool's `triggers.postAuthentication` reference resolves auth-internal). It
 * only does an `sqs:SendMessage` to a neutral queue stack — no data-client
 * edge — mirroring the postConfirmation → legacyClaim hand-off (#318).
 */
export const postAuthentication = defineFunction({
  name: 'postAuthentication',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
  resourceGroupName: 'auth',
});
