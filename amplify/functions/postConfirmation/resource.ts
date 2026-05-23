import { defineFunction } from '@aws-amplify/backend';

/**
 * Cognito Post-Confirmation trigger.
 *
 * Fires after a user verifies their email (self-signup) or after an admin
 * confirms them. Adds the new user to the `member` group so the rest of the
 * system can use group-based authorization without manual provisioning.
 *
 * Idempotent: Cognito's `AdminAddUserToGroup` succeeds whether or not the user
 * is already in the group, so re-confirmation (e.g. password reset followed by
 * re-verify) is safe.
 *
 * Issue #16 (legacy account claim by email-match) will extend this handler to
 * also link the new Cognito sub to any pre-seeded legacy User row.
 */
export const postConfirmation = defineFunction({
  name: 'postConfirmation',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
  // Cognito post-confirm trigger — grouped with `auth` so the User
  // Pool reference is auth-internal. The handoff to legacyClaimWorker
  // (in `data`) is decoupled via an SQS queue (wired in backend.ts)
  // so there is no IAM / env-var reference from the auth stack into
  // the data stack — that direct grantInvoke was the source of the
  // auth ↔ data leg of the nested-stack circular dependency (#317).
  resourceGroupName: 'auth',
});
