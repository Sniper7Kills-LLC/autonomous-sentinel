import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda-backed AppSync resolver for the `selfDelete` + `banUser` custom
 * mutations on the User model (issue #248).
 *
 * Dispatches on `event.info.fieldName`. Uses the cross-cutting AuditLog
 * helper (#258) to emit `USER_PII_BLANK` / `USER_BAN` rows. Wired into
 * the schema via `a.handler.function(userMutations)` from
 * `amplify/data/resource.ts`.
 *
 * Memory + timeout sized for a two-write workflow (User update +
 * AuditLog create) plus the Amplify Data client cold start. 256 MB is
 * enough for the SDK; bump if we observe sustained > 1s p95.
 */
export const userMutations = defineFunction({
  name: 'userMutations',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
});
