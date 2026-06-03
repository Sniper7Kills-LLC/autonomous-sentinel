import { a } from '@aws-amplify/backend';
import { wafMetrics } from '../../functions/wafMetrics/resource';

/**
 * `wafMetrics(windowHours)` — admin-only WAF blocked/allowed request counts
 * for the admin dashboard (#673).
 *
 * Returns `a.json()` (same pattern as `runCostSnapshotNow` / the DLQ admin
 * ops) so the shape can evolve without a schema migration. Resolved by the
 * `wafMetrics` Lambda, which reads CloudWatch (no DynamoDB).
 */
export const wafMetricsQuery = a
  .query()
  .arguments({ windowHours: a.integer() })
  .returns(a.json())
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(wafMetrics));
