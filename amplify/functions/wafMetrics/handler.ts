/**
 * `wafMetrics` AppSync resolver (#673).
 *
 * Returns blocked / allowed request counts for the WAF Web ACL over a window
 * (default 24h, admin-tunable per call via the `windowHours` argument), read
 * from CloudWatch `GetMetricStatistics` on the `AWS/WAFV2` namespace.
 *
 * Result shape (a.json()):
 *   { webAcl, windowHours, blockedRequests, allowedRequests, retrievedAt }
 *
 * CloudFront-scoped WAF publishes its metrics in us-east-1 with dimensions
 * { WebACL, Rule: 'ALL', Region: <WAF_METRIC_REGION|'Global'> }. The Region
 * dimension value is env-overridable so the exact value can be corrected
 * without a code change if AWS reports a different one for this account.
 */

import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';

export interface WafMetricsArgs {
  windowHours?: number | null;
}

export interface WafMetricsResult {
  webAcl: string;
  windowHours: number;
  blockedRequests: number;
  allowedRequests: number;
  retrievedAt: string;
}

export interface WafMetricsDeps {
  /** Sum of a WAF metric over [startMs, endMs). */
  metricSum: (metricName: string, startMs: number, endMs: number) => Promise<number>;
  now: () => number;
}

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30; // a month — keeps the CloudWatch query bounded

function clampWindow(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(Math.floor(raw), MAX_WINDOW_HOURS);
}

let cachedDeps: WafMetricsDeps | null = null;

function defaultDeps(): WafMetricsDeps {
  // CloudFront WAF metrics live in us-east-1 regardless of the caller region.
  const cw = new CloudWatchClient({ region: 'us-east-1' });
  const webAclName = process.env.WEB_ACL_NAME ?? 'EamWebAcl';
  const regionDim = process.env.WAF_METRIC_REGION ?? 'Global';

  return {
    metricSum: async (metricName, startMs, endMs) => {
      const res = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: 'AWS/WAFV2',
          MetricName: metricName,
          Dimensions: [
            { Name: 'WebACL', Value: webAclName },
            { Name: 'Rule', Value: 'ALL' },
            { Name: 'Region', Value: regionDim },
          ],
          StartTime: new Date(startMs),
          EndTime: new Date(endMs),
          // CloudWatch caps Period at 86400s (1 day); windows longer than a
          // day return multiple daily buckets, which the caller sums. Floor at
          // 60s, the minimum granularity.
          Period: Math.min(86400, Math.max(60, Math.ceil((endMs - startMs) / 1000))),
          Statistics: ['Sum'],
        }),
      );
      return (res.Datapoints ?? []).reduce((acc, d) => acc + (d.Sum ?? 0), 0);
    },
    now: () => Date.now(),
  };
}

function activeDeps(): WafMetricsDeps {
  if (!cachedDeps) cachedDeps = defaultDeps();
  return cachedDeps;
}

export function __setDeps(deps: WafMetricsDeps): void {
  cachedDeps = deps;
}
export function __resetDeps(): void {
  cachedDeps = null;
}

export async function computeWafMetrics(
  deps: WafMetricsDeps,
  windowHours: number,
): Promise<WafMetricsResult> {
  const end = deps.now();
  const start = end - windowHours * 3600 * 1000;
  const [blockedRequests, allowedRequests] = await Promise.all([
    deps.metricSum('BlockedRequests', start, end),
    deps.metricSum('AllowedRequests', start, end),
  ]);
  return {
    webAcl: process.env.WEB_ACL_NAME ?? 'EamWebAcl',
    windowHours,
    blockedRequests,
    allowedRequests,
    retrievedAt: new Date(end).toISOString(),
  };
}

export const handler = async (
  event: AppSyncResolverEvent<WafMetricsArgs>,
  _context?: Context,
): Promise<WafMetricsResult> => {
  const windowHours = clampWindow(event.arguments?.windowHours);
  return computeWafMetrics(activeDeps(), windowHours);
};
