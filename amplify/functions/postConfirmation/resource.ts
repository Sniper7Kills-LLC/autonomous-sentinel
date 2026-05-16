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
});
