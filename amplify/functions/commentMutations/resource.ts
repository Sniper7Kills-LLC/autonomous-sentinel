import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda-backed AppSync resolver for Comment custom mutations (#32).
 *
 * Dispatches `createComment` (depth-clamp + flatten) and
 * `softDeleteComment` (author / mod / admin → sets deletedAt +
 * rewrites body to `[removed]` + emits COMMENT_DELETE audit).
 *
 * Schema wiring lives in `amplify/data/resource.ts`; IAM grants
 * in `amplify/backend.ts`.
 */
export const commentMutations = defineFunction({
  name: 'commentMutations',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
});
