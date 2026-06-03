import { defineFunction } from '@aws-amplify/backend';

/**
 * `wafMetrics` — admin AppSync resolver returning WAF blocked/allowed request
 * counts for the admin dashboard (#673).
 *
 * Reads CloudWatch `GetMetricStatistics` for the `AWS/WAFV2` `BlockedRequests`
 * / `AllowedRequests` metrics on the `EamWebAcl` Web ACL. CloudWatch-only (no
 * DynamoDB), so there is no function→data edge; `resourceGroupName:'data'`
 * keeps it in the data stack with the other resolver Lambdas and avoids the
 * shared generic `function` stack (which would risk a cross-stack cycle —
 * see the wafSync note in backend.ts).
 */
export const wafMetrics = defineFunction({
  name: 'wafMetrics',
  entry: './handler.ts',
  timeoutSeconds: 15,
  memoryMB: 256,
  resourceGroupName: 'data',
});
