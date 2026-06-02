import { describe, it, expect } from 'vitest';
import {
  aggregateCost,
  aggregateRevenue,
  windowStartDate,
  formatBytes,
  type CostSnapshotRow,
  type RevenueSnapshotRow,
} from './transparency';

function cost(
  partial: Partial<CostSnapshotRow> &
    Pick<CostSnapshotRow, 'category' | 'subject' | 'snapshotDate'>,
): CostSnapshotRow {
  return {
    usdAmount: null,
    unit: null,
    meta: {},
    ...partial,
  };
}

describe('transparency aggregation (#303)', () => {
  describe('windowStartDate', () => {
    it('computes an inclusive 30-day window', () => {
      expect(windowStartDate(new Date('2026-06-01T05:00:00Z'), 30)).toBe('2026-05-03');
    });
  });

  describe('aggregateCost', () => {
    it('sums AWS_SERVICE rows per service across the window and totals them', () => {
      const rows = [
        cost({
          category: 'AWS_SERVICE',
          subject: 'AWS Lambda',
          snapshotDate: '2026-05-30',
          usdAmount: 1,
        }),
        cost({
          category: 'AWS_SERVICE',
          subject: 'AWS Lambda',
          snapshotDate: '2026-05-31',
          usdAmount: 2,
        }),
        cost({
          category: 'AWS_SERVICE',
          subject: 'Amazon DynamoDB',
          snapshotDate: '2026-05-31',
          usdAmount: 0.5,
        }),
      ];
      const agg = aggregateCost(rows, '2026-05-01');
      expect(agg.totalUsd).toBe(3.5);
      expect(agg.byService).toEqual([
        { service: 'AWS Lambda', usd: 3 },
        { service: 'Amazon DynamoDB', usd: 0.5 },
      ]);
    });

    it('excludes rows before the window start', () => {
      const rows = [
        cost({
          category: 'AWS_SERVICE',
          subject: 'AWS Lambda',
          snapshotDate: '2026-04-30',
          usdAmount: 99,
        }),
        cost({
          category: 'AWS_SERVICE',
          subject: 'AWS Lambda',
          snapshotDate: '2026-05-15',
          usdAmount: 1,
        }),
      ];
      const agg = aggregateCost(rows, '2026-05-01');
      expect(agg.totalUsd).toBe(1);
    });

    it('keeps only the latest S3_PREFIX snapshot per prefix (no double-count of storage)', () => {
      const rows = [
        cost({
          category: 'S3_PREFIX',
          subject: 'recordings/originals/',
          snapshotDate: '2026-05-30',
          meta: { bytes: 100, objects: 2 },
        }),
        cost({
          category: 'S3_PREFIX',
          subject: 'recordings/originals/',
          snapshotDate: '2026-05-31',
          meta: { bytes: 150, objects: 3 },
        }),
        cost({
          category: 'S3_PREFIX',
          subject: 'exports/',
          snapshotDate: '2026-05-31',
          meta: { bytes: 10, objects: 1 },
        }),
      ];
      const agg = aggregateCost(rows, '2026-05-01');
      expect(agg.s3Prefixes).toEqual([
        { prefix: 'recordings/originals/', bytes: 150, objects: 3 },
        { prefix: 'exports/', bytes: 10, objects: 1 },
      ]);
    });

    it('keeps only the latest LAMBDA_FUNCTION snapshot per function', () => {
      const rows = [
        cost({
          category: 'LAMBDA_FUNCTION',
          subject: 'preprocess',
          snapshotDate: '2026-05-30',
          meta: { invocations: 5, durationGbSeconds: 1 },
        }),
        cost({
          category: 'LAMBDA_FUNCTION',
          subject: 'preprocess',
          snapshotDate: '2026-05-31',
          meta: { invocations: 8, durationGbSeconds: 2 },
        }),
      ];
      const agg = aggregateCost(rows, '2026-05-01');
      expect(agg.lambdaFunctions).toEqual([
        { functionName: 'preprocess', invocations: 8, durationGbSeconds: 2 },
      ]);
    });

    it('treats null usdAmount as zero', () => {
      const rows = [
        cost({
          category: 'AWS_SERVICE',
          subject: 'X',
          snapshotDate: '2026-05-31',
          usdAmount: null,
        }),
      ];
      expect(aggregateCost(rows, '2026-05-01').totalUsd).toBe(0);
    });
  });

  describe('aggregateRevenue', () => {
    it('reports hasData=false on an empty (Stripe-deferred) set', () => {
      const agg = aggregateRevenue([], '2026-05-01');
      expect(agg.hasData).toBe(false);
      expect(agg.totalUsd).toBe(0);
    });

    it('sums revenue per category when rows exist', () => {
      const rows: RevenueSnapshotRow[] = [
        {
          category: 'REVENUE_DONATION',
          subject: 'one-time',
          snapshotDate: '2026-05-31',
          usdAmount: 10,
          unit: 'USD',
          meta: {},
        },
        {
          category: 'REVENUE_SUBSCRIPTION',
          subject: 'Tier 1',
          snapshotDate: '2026-05-31',
          usdAmount: 3,
          unit: 'USD',
          meta: {},
        },
      ];
      const agg = aggregateRevenue(rows, '2026-05-01');
      expect(agg.hasData).toBe(true);
      expect(agg.totalUsd).toBe(13);
      expect(agg.byCategory[0]).toEqual({ category: 'REVENUE_DONATION', usd: 10 });
    });
  });

  describe('formatBytes', () => {
    it('formats human-readable sizes', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });
  });
});
