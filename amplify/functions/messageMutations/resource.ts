import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda-backed AppSync resolver for Message custom mutations (#28).
 *
 * Currently dispatches `softDeleteMessage`. Add new Message-related
 * admin mutations here as they land (restore, edit, etc.) so the
 * cross-cutting AuditLog helper (#258) stays in one Lambda per model.
 *
 * Schema wiring lives in `amplify/data/resource.ts`; IAM grants in
 * `amplify/backend.ts`.
 */
export const messageMutations = defineFunction({
  name: 'messageMutations',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
  // AppSync data resolver + DDB consumer (Message + AuditLog) —
  // grouped with `data` to break the function ↔ auth ↔ data
  // nested-stack circular dependency (#317).
  resourceGroupName: 'data',
});
