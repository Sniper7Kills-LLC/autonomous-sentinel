/**
 * Pure helpers for `costSnapshotWorker` (#303).
 *
 * Everything here is side-effect-free so it can be unit-tested without
 * mocking AWS: it maps Cost Explorer / CloudWatch / S3 responses into
 * the flat CostSnapshot row shape the page reads.
 */

export type CostCategory = 'AWS_SERVICE' | 'S3_PREFIX' | 'LAMBDA_FUNCTION';

export interface CostRow {
  snapshotDate: string;
  subject: string;
  category: CostCategory;
  usdAmount: number;
  unit: string;
  meta: Record<string, unknown>;
}

/**
 * Canonical S3 prefixes we break the storage line item down by. Order
 * matters: the most specific prefix must come first so a key under
 * `recordings/web/` is not mis-bucketed into `recordings/`.
 */
export const S3_PREFIXES = [
  'recordings/originals/',
  'recordings/web/',
  'recordings/',
  'sidecars/',
  'pipeline-temp/',
  'exports/',
] as const;

export type S3Prefix = (typeof S3_PREFIXES)[number];

/** Bucket of running totals per prefix. */
export interface PrefixAccumulator {
  prefix: S3Prefix | 'other';
  bytes: number;
  objects: number;
}

/**
 * Map an S3 object key to the canonical prefix bucket it belongs to.
 * Falls back to `'other'` for keys that match none of the known
 * prefixes (kept visible so unexplained storage shows up rather than
 * silently vanishing).
 */
export function categorizeS3Key(key: string): S3Prefix | 'other' {
  for (const prefix of S3_PREFIXES) {
    if (key.startsWith(prefix)) return prefix;
  }
  return 'other';
}

/**
 * Roll a list of (key, size) S3 objects up into per-prefix totals.
 */
export function accumulateS3Prefixes(
  objects: { key: string; size: number }[],
): PrefixAccumulator[] {
  const totals = new Map<string, PrefixAccumulator>();
  for (const obj of objects) {
    const prefix = categorizeS3Key(obj.key);
    const existing = totals.get(prefix) ?? { prefix, bytes: 0, objects: 0 };
    existing.bytes += obj.size;
    existing.objects += 1;
    totals.set(prefix, existing);
  }
  return Array.from(totals.values());
}

/**
 * Cost Explorer `GetCostAndUsage` GroupBy=SERVICE rows → AWS_SERVICE
 * CostSnapshot rows. Skips zero-cost services to keep the table small;
 * a service that genuinely costs $0 for the day adds no signal.
 */
export function mapCostExplorerRows(
  snapshotDate: string,
  groups: { service: string; amount: string; unit?: string }[],
): CostRow[] {
  const rows: CostRow[] = [];
  for (const g of groups) {
    const usd = Number.parseFloat(g.amount);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    rows.push({
      snapshotDate,
      subject: g.service,
      category: 'AWS_SERVICE',
      usdAmount: round4(usd),
      unit: g.unit ?? 'USD',
      meta: {},
    });
  }
  return rows;
}

/**
 * CloudWatch Lambda metrics → LAMBDA_FUNCTION rows. We store the raw
 * invocation count + total GB-seconds in `meta` (so the page can
 * explain the compute line) but leave `usdAmount` at 0 — the dollar
 * figure for Lambda already lands via the Cost Explorer AWS_SERVICE
 * "AWS Lambda" row, and double-counting it here would inflate totals.
 */
export function mapLambdaMetricRows(
  snapshotDate: string,
  metrics: { functionName: string; invocations: number; durationGbSeconds: number }[],
): CostRow[] {
  return metrics
    .filter((m) => m.invocations > 0 || m.durationGbSeconds > 0)
    .map((m) => ({
      snapshotDate,
      subject: m.functionName,
      category: 'LAMBDA_FUNCTION' as const,
      usdAmount: 0,
      unit: 'GB-seconds',
      meta: {
        invocations: m.invocations,
        durationGbSeconds: round4(m.durationGbSeconds),
      },
    }));
}

/**
 * Per-prefix S3 accumulators → S3_PREFIX rows. `usdAmount` is left at 0
 * for the same reason as Lambda: the dollar value lands on the Cost
 * Explorer "Amazon Simple Storage Service" row; these rows explain the
 * *composition* of that line via bytes + object counts in `meta`.
 */
export function mapS3PrefixRows(
  snapshotDate: string,
  accumulators: PrefixAccumulator[],
): CostRow[] {
  return accumulators.map((a) => ({
    snapshotDate,
    subject: a.prefix,
    category: 'S3_PREFIX' as const,
    usdAmount: 0,
    unit: 'bytes',
    meta: {
      bytes: a.bytes,
      objects: a.objects,
    },
  }));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Resolve the snapshot date string (YYYY-MM-DD) for "yesterday" in UTC
 * — the Cost Explorer window the daily 05:00 cron reports on. Cost
 * Explorer's most recent fully-settled day is the previous UTC day.
 */
export function previousUtcDate(now: Date): string {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
