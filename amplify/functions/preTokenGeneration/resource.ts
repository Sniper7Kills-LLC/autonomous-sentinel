import { defineFunction } from '@aws-amplify/backend';

/**
 * Cognito Pre-Token-Generation trigger (#334).
 *
 * Injects `custom:role` (highest of admin/moderator/member from
 * cognito:groups) and `custom:repWeight` (Reputation.computedWeight)
 * into every issued ID token so the frontend + AppSync resolvers can
 * read both values from the JWT instead of a per-request DDB read.
 *
 * Grouped with `auth` (same pattern as postConfirmation) so the User
 * Pool's `triggers.preTokenGeneration` reference resolves
 * auth-internal — keeps the trigger arn on the auth nested stack and
 * avoids re-opening the nested-stack cycle that #317 / #318 closed.
 *
 * Cross-stack edge to the `data` stack: the handler reads
 * `Reputation.computedWeight` via DynamoDB GetItem. The IAM grant +
 * `REPUTATION_TABLE_NAME` env var are wired in `backend.ts` (same
 * shape as the getUserPublicLambda → User table grant).
 */
export const preTokenGeneration = defineFunction({
  name: 'preTokenGeneration',
  entry: './handler.ts',
  timeoutSeconds: 5,
  memoryMB: 256,
  resourceGroupName: 'auth',
});
