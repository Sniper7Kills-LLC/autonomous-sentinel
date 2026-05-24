import { defineFunction } from '@aws-amplify/backend';

/**
 * Cognito Pre-Authentication trigger (#335).
 *
 * Blocks native username/password sign-in when the caller's User row
 * carries a `bannedAt` timestamp. Throwing in the handler causes
 * Cognito to fail the auth with `NotAuthorizedException`.
 *
 * Grouped with `auth` (same pattern as postConfirmation + preTokenGeneration)
 * so the User Pool's `triggers.preAuthentication` reference resolves
 * auth-internal — keeps the trigger ARN on the auth nested stack and
 * stays clear of the cycle that #317 / #318 closed.
 *
 * Cross-stack edge to the `data` stack: the handler reads
 * `User.bannedAt` via DynamoDB GetItem. The IAM grant +
 * `USER_TABLE_NAME` env var are wired in `backend.ts` (same shape as
 * the getUserPublicLambda → User table grant).
 */
export const preAuth = defineFunction({
  name: 'preAuth',
  entry: './handler.ts',
  timeoutSeconds: 5,
  memoryMB: 256,
  resourceGroupName: 'auth',
});
