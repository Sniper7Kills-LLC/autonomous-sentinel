'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Cost-transparency data layer (#303).
 *
 * Reads `CostSnapshot` (public, guest-readable) + `RevenueSnapshot`
 * (admin/mod only) rows and folds them into the shapes the
 * `/transparency` page renders. The aggregation is pure + exported so
 * it can be unit-tested without Amplify.
 */

export type CostCategory = 'AWS_SERVICE' | 'S3_PREFIX' | 'LAMBDA_FUNCTION';

export interface CostSnapshotRow {
  snapshotDate: string;
  subject: string;
  category: string;
  usdAmount: number | null;
  unit: string | null;
  meta: Record<string, unknown>;
}

export interface RevenueSnapshotRow {
  snapshotDate: string;
  subject: string;
  category: string;
  usdAmount: number | null;
  unit: string | null;
  meta: Record<string, unknown>;
}

export interface ServiceTotal {
  service: string;
  usd: number;
}

export interface PrefixBreakdown {
  prefix: string;
  bytes: number;
  objects: number;
}

export interface FunctionBreakdown {
  functionName: string;
  invocations: number;
  durationGbSeconds: number;
}

export interface CostAggregate {
  /** Inclusive window start (YYYY-MM-DD). */
  fromDate: string;
  /** Total USD across all AWS_SERVICE rows in the window. */
  totalUsd: number;
  /** Per-service USD totals, descending by spend. */
  byService: ServiceTotal[];
  /** S3 storage composition (latest snapshot in window per prefix). */
  s3Prefixes: PrefixBreakdown[];
  /** Lambda compute composition (latest snapshot in window per function). */
  lambdaFunctions: FunctionBreakdown[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Compute the inclusive lower-bound snapshotDate for a rolling window.
 * `windowDays = 30` over a `now` of 2026-06-01 → 2026-05-02.
 */
export function windowStartDate(now: Date, windowDays: number): string {
  const d = new Date(now.getTime() - (windowDays - 1) * MS_PER_DAY);
  return d.toISOString().slice(0, 10);
}

/**
 * Fold raw CostSnapshot rows into the page aggregate.
 *
 * - AWS_SERVICE rows sum per service across every day in the window
 *   (this is the dollar figure users see).
 * - S3_PREFIX / LAMBDA_FUNCTION rows describe *composition*, not extra
 *   dollars, so we keep only the most-recent snapshot per subject
 *   (summing storage bytes across days would double-count standing
 *   storage).
 */
export function aggregateCost(rows: CostSnapshotRow[], fromDate: string): CostAggregate {
  const inWindow = rows.filter((r) => r.snapshotDate >= fromDate);

  const serviceTotals = new Map<string, number>();
  // Track latest snapshotDate seen per (category, subject) for the
  // composition rows so we surface the freshest figure only.
  const latestS3 = new Map<string, { date: string; row: CostSnapshotRow }>();
  const latestFn = new Map<string, { date: string; row: CostSnapshotRow }>();

  let totalUsd = 0;
  for (const r of inWindow) {
    if (r.category === 'AWS_SERVICE') {
      const usd = num(r.usdAmount);
      serviceTotals.set(r.subject, (serviceTotals.get(r.subject) ?? 0) + usd);
      totalUsd += usd;
    } else if (r.category === 'S3_PREFIX') {
      const cur = latestS3.get(r.subject);
      if (!cur || r.snapshotDate > cur.date) {
        latestS3.set(r.subject, { date: r.snapshotDate, row: r });
      }
    } else if (r.category === 'LAMBDA_FUNCTION') {
      const cur = latestFn.get(r.subject);
      if (!cur || r.snapshotDate > cur.date) {
        latestFn.set(r.subject, { date: r.snapshotDate, row: r });
      }
    }
  }

  const byService: ServiceTotal[] = Array.from(serviceTotals.entries())
    .map(([service, usd]) => ({ service, usd: round2(usd) }))
    .sort((a, b) => b.usd - a.usd);

  const s3Prefixes: PrefixBreakdown[] = Array.from(latestS3.values())
    .map(({ row }) => ({
      prefix: row.subject,
      bytes: num(row.meta.bytes),
      objects: num(row.meta.objects),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const lambdaFunctions: FunctionBreakdown[] = Array.from(latestFn.values())
    .map(({ row }) => ({
      functionName: row.subject,
      invocations: num(row.meta.invocations),
      durationGbSeconds: num(row.meta.durationGbSeconds),
    }))
    .sort((a, b) => b.invocations - a.invocations);

  return {
    fromDate,
    totalUsd: round2(totalUsd),
    byService,
    s3Prefixes,
    lambdaFunctions,
  };
}

export interface RevenueAggregate {
  fromDate: string;
  totalUsd: number;
  byCategory: { category: string; usd: number }[];
  hasData: boolean;
}

/**
 * Fold raw RevenueSnapshot rows. Stays empty until Stripe ships (the
 * `stripeRevenueWorker` writes nothing live), so `hasData` drives the
 * "no revenue data yet" panel state.
 */
export function aggregateRevenue(rows: RevenueSnapshotRow[], fromDate: string): RevenueAggregate {
  const inWindow = rows.filter((r) => r.snapshotDate >= fromDate);
  const byCategoryMap = new Map<string, number>();
  let totalUsd = 0;
  for (const r of inWindow) {
    const usd = num(r.usdAmount);
    byCategoryMap.set(r.category, (byCategoryMap.get(r.category) ?? 0) + usd);
    totalUsd += usd;
  }
  return {
    fromDate,
    totalUsd: round2(totalUsd),
    byCategory: Array.from(byCategoryMap.entries())
      .map(([category, usd]) => ({ category, usd: round2(usd) }))
      .sort((a, b) => b.usd - a.usd),
    hasData: inWindow.length > 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Human-readable byte size for the storage explanation block. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Amplify Data reads
// ---------------------------------------------------------------------------

type RawRow = {
  snapshotDate: string;
  subject: string;
  category: string;
  usdAmount?: number | null;
  unit?: string | null;
  meta?: unknown;
};

type RawListResult = {
  data?: RawRow[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

function parseMeta(meta: unknown): Record<string, unknown> {
  if (typeof meta === 'string') {
    try {
      const parsed: unknown = JSON.parse(meta);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {};
}

function toCostRow(r: RawRow): CostSnapshotRow {
  return {
    snapshotDate: r.snapshotDate,
    subject: r.subject,
    category: r.category,
    usdAmount: r.usdAmount ?? null,
    unit: r.unit ?? null,
    meta: parseMeta(r.meta),
  };
}

/**
 * Page through every CostSnapshot row on or after `fromDate`. Uses the
 * guest-compatible auth mode (identityPool for signed-out visitors) so
 * the public cost panel works without a login.
 */
export async function fetchCostSnapshots(fromDate: string): Promise<CostSnapshotRow[]> {
  const client = getDataClient();
  const authMode = await resolveAuthMode();
  const listFn = client.models.CostSnapshot.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult>;

  const out: CostSnapshotRow[] = [];
  let nextToken: string | null | undefined;
  do {
    const raw = await listFn({
      filter: { snapshotDate: { ge: fromDate } },
      limit: 1000,
      nextToken: nextToken ?? undefined,
      authMode,
    });
    if (raw.errors?.length) {
      throw new Error(raw.errors.map((e) => e.message).join('; '));
    }
    for (const r of raw.data ?? []) out.push(toCostRow(r));
    nextToken = raw.nextToken;
  } while (nextToken);
  return out;
}

// Admin on-demand cost-sync (`runCostSnapshotNow`) was removed — the
// EventBridge trigger reintroduced a CFN circular dependency. On-demand
// sync is deferred to the SQS-based follow-up (#644); the daily cron
// keeps the snapshots fresh.

/**
 * Page through RevenueSnapshot rows. Always uses `userPool` — these
 * rows are gated to admin/moderator. A guest / member call returns an
 * authz error, which the caller swallows into an empty list.
 */
export async function fetchRevenueSnapshots(fromDate: string): Promise<RevenueSnapshotRow[]> {
  const client = getDataClient();
  const listFn = client.models.RevenueSnapshot.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult>;

  const out: RevenueSnapshotRow[] = [];
  let nextToken: string | null | undefined;
  do {
    const raw = await listFn({
      filter: { snapshotDate: { ge: fromDate } },
      limit: 1000,
      nextToken: nextToken ?? undefined,
      authMode: 'userPool',
    });
    if (raw.errors?.length) {
      throw new Error(raw.errors.map((e) => e.message).join('; '));
    }
    for (const r of raw.data ?? []) out.push(toCostRow(r));
    nextToken = raw.nextToken;
  } while (nextToken);
  return out;
}
