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
  // Pool's `triggers.postConfirmation` reference resolves
  // auth-internal (no cross-stack edge from auth to function). The
  // direct `lambda.grantInvoke` + `LEGACY_CLAIM_WORKER_FUNCTION_NAME`
  // env var still wired in `backend.ts` keep an auth → data edge
  // that is the remaining leg of the nested-stack circular
  // dependency (#317). That edge is the subject of the SQS-handoff
  // follow-up (#318); this PR fixes the other two cycle legs and
  // accepts the remaining triangle for the follow-up to close.
  resourceGroupName: 'auth',
});
