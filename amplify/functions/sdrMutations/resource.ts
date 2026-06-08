import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda-backed AppSync resolver for SDR custom mutations (#785).
 *
 * Dispatches on `event.info.fieldName`:
 *   - `submitPublicSdr` — authenticated members submit a PUBLIC SDR (third-party
 *     public receiver like KiwiSDR/WebSDR) for admin review. Sets kind=PUBLIC,
 *     submitterId=caller, reviewStatus=PENDING, ownerId=null. Writes a
 *     SDR_SUBMIT_PUBLIC AuditLog entry.
 *   - `reviewSdr` — admin-only. Approves or rejects a PUBLIC SDR submission.
 *     Sets reviewStatus, reviewedBy, reviewedAt, reviewNote. Writes SDR_REVIEW
 *     AuditLog entry. Idempotent-ish.
 *
 * Mirrors the messageMutations + transcriptRevisionMutations pattern exactly:
 * dependency-injected deps, resourceGroupName:'data' to break CFN cycles.
 */
export const sdrMutations = defineFunction({
  name: 'sdrMutations',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
  // Grouped with `data` to break the function ↔ auth ↔ data nested-stack
  // circular dependency, per the established pattern (#317).
  resourceGroupName: 'data',
});
