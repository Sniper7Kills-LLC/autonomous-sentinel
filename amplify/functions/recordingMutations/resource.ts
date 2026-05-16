import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda-backed AppSync resolver for Recording custom mutations (#29).
 *
 * Currently dispatches `softDeleteRecording`. Add new
 * Recording-related admin mutations (restore, reprocess, etc.) here
 * so the cross-cutting AuditLog helper (#258) stays in one Lambda
 * per model.
 *
 * Schema wiring lives in `amplify/data/resource.ts`; IAM grants in
 * `amplify/backend.ts`.
 */
export const recordingMutations = defineFunction({
  name: 'recordingMutations',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
});
