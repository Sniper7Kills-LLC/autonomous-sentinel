import { defineFunction } from '@aws-amplify/backend';

/**
 * `wafSync` — DynamoDB-stream-driven reconciler that pushes the admin-managed
 * `BannedCountry` / `BannedIp` lists into live WAF state (#199/#200/#201).
 *
 * Triggered by the streams on both ban tables (wiring in `amplify/backend.ts`).
 * Each invocation does a full, idempotent reconcile: Scan both tables → project
 * onto four WAF IPSets + the two runtime-injected geo rules.
 *
 * NOT in the data resource group: the handler reads via the raw DynamoDB SDK
 * (Scan), never the Amplify Data client, so there is no `allow.resource` edge
 * from the data stack to this function. The only cross-stack edges are this
 * function → {ban-table streams/ARNs, WAF resources}, all one-directional, so
 * no CloudFormation circular dependency is introduced (see backend.ts note).
 *
 * Reserved concurrency 1 + a DLQ on the event-source mappings are applied in
 * backend.ts so the optimistic WAF `LockToken` doesn't thrash under bursts.
 */
export const wafSync = defineFunction({
  name: 'wafSync',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 256,
});
