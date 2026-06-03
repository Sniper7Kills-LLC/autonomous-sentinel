import { defineFunction } from '@aws-amplify/backend';

/**
 * `promptTemplateMutations` — Lambda-backed AppSync resolver for the
 * atomic LinguisticPromptTemplate admin mutations (#572).
 *
 * Dispatches on `event.info.fieldName`:
 *   - `activatePromptTemplate` — admin-only. Flips exactly one version
 *     of a `promptId` to `isActive=true` and every other to `false`
 *     inside a single DynamoDB `TransactWriteItems`, so concurrent
 *     admins can never leave zero or two active rows.
 *   - `savePromptTemplateVersion` — admin-only. Allocates the next
 *     `version` for a `promptId` and creates the row under a
 *     conditional `attribute_not_exists(id)` guard on a synthesised
 *     `promptId#v{version}` key, so a version number can never collide
 *     under concurrent saves (the loser retries with the new max).
 *
 * Why raw DynamoDB (vs the Amplify Data client the other resolver
 * Lambdas use): the Amplify Data client exposes neither
 * TransactWriteItems nor conditional writes, both of which this issue
 * needs for correctness. The table is admin-managed and tiny, so the
 * version-max + active-row lookups Scan + filter in memory (matching
 * the model docstring — no GSI).
 *
 * Schema wiring lives in `data/models/linguistic-prompt-template.ts`;
 * the table-name env var + DDB IAM grant wire in `amplify/backend.ts`.
 */
export const promptTemplateMutations = defineFunction({
  name: 'promptTemplateMutations',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
  // AppSync data resolver + direct DDB (Scan/Get/Put/TransactWrite) on
  // the LinguisticPromptTemplate table — grouped with `data` to break
  // the function ↔ auth ↔ data nested-stack circular dependency (#317),
  // same pattern as recordingMutations / notificationPreferenceMutations.
  resourceGroupName: 'data',
});
