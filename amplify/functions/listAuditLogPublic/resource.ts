import { defineFunction } from '@aws-amplify/backend';

/**
 * Lambda-backed AppSync resolver for the `listAuditLogPublic` query
 * (#38). PII-filtered AuditLog read for guest + authenticated
 * callers; replaces the prior broad `allow.guest()` /
 * `allow.authenticated()` reads on the AuditLog model itself.
 *
 * Schema wiring lives in `amplify/data/resource.ts`; IAM grant is
 * the schema-level `allow.resource(listAuditLogPublic).to(['query'])`.
 */
export const listAuditLogPublic = defineFunction({
  name: 'listAuditLogPublic',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
});
