import { defineFunction } from '@aws-amplify/backend';

/**
 * `getUserPublicLambda` — Lambda-backed AppSync resolver for the
 * `getUserPublic` custom query (#271).
 *
 * Replaces the original `a.handler.custom` JS resolver. The Lambda
 * form supports `allow.guest()` under the identityPool default
 * auth mode that the custom JS form does not.
 *
 * Schema wiring lives in `data/models/user.ts`; IAM grant
 * (`USER_TABLE_NAME` env + `dynamodb:GetItem` on the User table)
 * in `amplify/backend.ts`.
 */
export const getUserPublicLambda = defineFunction({
  name: 'getUserPublicLambda',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
});
