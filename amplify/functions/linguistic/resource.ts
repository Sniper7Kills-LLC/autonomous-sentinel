import { defineFunction } from '@aws-amplify/backend';

/**
 * Linguistic Logic Lambda.
 *
 * Hybrid: rules + regex first; Bedrock AI fallback only when rules don't match.
 *
 * Per CLAUDE.md:
 *   - Rules / schemas / thresholds load from DynamoDB at runtime (admin-configurable).
 *   - Each recording tracks linguistic_attempts: [{provider, prompt_version, prompt_hash,
 *     result_hash, ts}]. Same (provider + prompt_version) never re-runs on same input.
 *   - Bumping prompt_version re-processes ONLY previously-failed recordings.
 *   - Confidence threshold default 0.8; auto-publish above, flag for review below.
 *   - AI provider stays in AWS (Bedrock).
 */
export const linguistic = defineFunction({
  name: 'linguistic',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 1024,
  // Grouped with `data` (#460) so the function lives in the data
  // nested stack. The handler holds a direct `dynamodb:Scan` grant on
  // the LinguisticRule table (rules-engine loader) — keeping the
  // function in the data stack makes that grant in-stack rather than a
  // `function → data` cross-stack edge, which (with the existing
  // `data → function` AppSync edge from `allow.resource(linguistic)`)
  // formed a nested-stack circular dependency (build job 116). Same
  // resolution as `legacyClaimWorker` (#317).
  resourceGroupName: 'data',
});
