import { defineFunction } from '@aws-amplify/backend';

/**
 * `wafSync` — DynamoDB-stream-driven reconciler that pushes the admin-managed
 * `BannedCountry` / `BannedIp` lists into live WAF state (#199/#200/#201).
 *
 * Triggered by the streams on both ban tables (wiring in `amplify/backend.ts`).
 * Each invocation does a full, idempotent reconcile: Scan both tables → project
 * onto four WAF IPSets + the two runtime-injected geo rules.
 *
 * `resourceGroupName: 'data'` places the Lambda INSIDE the data stack — the
 * same nested-stack circular-dependency fix used by `linguisticConfigStream`,
 * `revisionVoteScoreCron`, and `costSnapshotWorker` (#317). The ban tables and
 * their streams live in the data stack, so the EventSourceMappings + Scan/
 * stream IAM become INTRA-stack (no cross-stack edge). The handler still reads
 * via the raw DynamoDB SDK (Scan), never the Amplify Data client, so there is
 * no `allow.resource` data→function edge either. The only remaining cross-stack
 * edge is data → WafStack (the WAF resource ARNs for IAM + env), which is
 * one-directional (WafStack references nothing), so no cycle.
 *
 * NB: WITHOUT this, the Lambda lands in the shared generic `function` stack,
 * whose existing data edges turn these table imports into a cycle — observed at
 * deploy (synth passes, deploy fails) as a [TranscribeAwsStack, data, function]
 * circular dependency.
 *
 * Reserved concurrency 1 + a DLQ on the event-source mappings are applied in
 * backend.ts so the optimistic WAF `LockToken` doesn't thrash under bursts.
 */
export const wafSync = defineFunction({
  name: 'wafSync',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 256,
  resourceGroupName: 'data',
});
