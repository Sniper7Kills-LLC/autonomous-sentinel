'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';
import type { CharFrequencyBucket, CodewordFrequencyBucket } from '@/lib/stats/frequency';
import type { DailyCountBucket } from '@/lib/messages/aggregations';

/**
 * Precomputed stats reader (#780).
 *
 * The charts read corpus-wide counters from the `ChartAggregate` table instead
 * of pulling raw Messages and aggregating in the browser (supersedes the
 * client-side windowed aggregation in #499/#500 + the recent-N disclaimer).
 * One `list({ metric })` Query reads a whole chart's partition. The aggregator
 * already excludes soft-deleted / flagged / unpublished Messages, so these rows
 * reflect only validated, published broadcasts.
 *
 * The metric ids mirror `amplify/functions/chartAggregator/contributions.ts`.
 */

export const STAT_METRICS = {
  DAILY_COUNT: 'daily-count',
  CHAR_FREQ_ALLSTATIONS: 'char-freq-allstations',
  CODEWORD_SKYKING: 'codeword-skyking',
  CALLSIGN_USAGE: 'callsign-usage',
  PREAMBLE_FIRST2: 'preamble-first2',
} as const;

/** A single counter cell, normalized for the charts. */
export interface AggregateRow {
  dimension: string;
  count: number;
}

type RawRow = { dimension?: string | null; count?: number | null };
type RawListResult = {
  data?: RawRow[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

/**
 * Read every counter row for a metric (a single-partition Query, paged).
 * Reads run under the resolved session auth mode (guest read is granted).
 */
export async function listAggregate(metric: string): Promise<AggregateRow[]> {
  const client = getDataClient();
  const listFn = client.models.ChartAggregate.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const out: AggregateRow[] = [];
  let nextToken: string | null = null;
  do {
    const res: RawListResult = await listFn({ metric, authMode, nextToken, limit: 1000 });
    if (res.errors && res.errors.length > 0) {
      throw new Error(
        `listAggregate(${metric}) failed: ${res.errors.map((e) => e.message).join('; ')}`,
      );
    }
    for (const r of res.data ?? []) {
      if (typeof r.dimension === 'string') {
        out.push({ dimension: r.dimension, count: typeof r.count === 'number' ? r.count : 0 });
      }
    }
    nextToken = res.nextToken ?? null;
  } while (nextToken);
  return out;
}

/* ------------------------------------------------------------------ *
 * Pure transforms: counter rows → the bucket shapes the charts render.
 * Pruned-to-zero / negative drift rows are dropped.
 * ------------------------------------------------------------------ */

export function toCharFrequency(rows: AggregateRow[]): CharFrequencyBucket[] {
  return rows
    .filter((r) => r.count > 0)
    .map((r) => ({ char: r.dimension, count: r.count }))
    .sort((a, b) => b.count - a.count || a.char.localeCompare(b.char));
}

export function toCodewordFrequency(rows: AggregateRow[]): CodewordFrequencyBucket[] {
  return rows
    .filter((r) => r.count > 0)
    .map((r) => ({ codeword: r.dimension, count: r.count }))
    .sort((a, b) => b.count - a.count || a.codeword.localeCompare(b.codeword));
}

export interface UsageBucket {
  label: string;
  count: number;
}

/** Generic single-dimension ranking (callsign usage, preamble counts). */
export function toRanking(rows: AggregateRow[]): UsageBucket[] {
  return rows
    .filter((r) => r.count > 0)
    .map((r) => ({ label: r.dimension, count: r.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface DailyTypeRow {
  date: string;
  total: number;
  /** per-type counts keyed by message type */
  [type: string]: number | string;
}

/** Parse `daily-count` rows (dimension `YYYY-MM-DD#TYPE`) into a per-day,
 *  per-type series plus the sorted list of types present. */
export function toDailyTypeCounts(rows: AggregateRow[]): {
  dates: DailyTypeRow[];
  types: string[];
} {
  const byDate = new Map<string, Map<string, number>>();
  const typeSet = new Set<string>();
  for (const r of rows) {
    if (r.count <= 0) continue;
    const i = r.dimension.indexOf('#');
    if (i < 0) continue;
    const date = r.dimension.slice(0, i);
    const type = r.dimension.slice(i + 1);
    if (!date || !type) continue;
    typeSet.add(type);
    let m = byDate.get(date);
    if (!m) {
      m = new Map();
      byDate.set(date, m);
    }
    m.set(type, (m.get(type) ?? 0) + r.count);
  }
  const types = [...typeSet].sort();
  const dates: DailyTypeRow[] = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, m]) => {
      const row: DailyTypeRow = { date, total: 0 };
      let total = 0;
      for (const t of types) {
        const c = m.get(t) ?? 0;
        row[t] = c;
        total += c;
      }
      row.total = total;
      return row;
    });
  return { dates, types };
}

/** Daily totals across all types (the legacy single-series daily chart). */
export function toDailyTotals(rows: AggregateRow[]): DailyCountBucket[] {
  return toDailyTypeCounts(rows).dates.map((d) => ({ date: d.date, count: d.total }));
}

export interface StreakInfo {
  type: string;
  /** Consecutive days up to and including the most recent active day. */
  current: number;
  /** Longest consecutive-day run ever. */
  longest: number;
  lastDate: string | null;
}

function dayNumber(date: string): number {
  // Days since epoch for a YYYY-MM-DD string (UTC midnight).
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 86_400_000);
}

/**
 * Consecutive-day streaks per type, derived from the precomputed `daily-count`
 * rows (#780). `current` is the run ending at the type's most recent active
 * day; `longest` is the longest run ever. The corpus aggregation it reads is
 * precomputed — only this trivial scan of ~one-number-per-day runs client-side.
 */
export function toStreaks(rows: AggregateRow[]): StreakInfo[] {
  const daysByType = new Map<string, Set<number>>();
  const lastByType = new Map<string, string>();
  for (const r of rows) {
    if (r.count <= 0) continue;
    const i = r.dimension.indexOf('#');
    if (i < 0) continue;
    const date = r.dimension.slice(0, i);
    const type = r.dimension.slice(i + 1);
    const n = dayNumber(date);
    if (!type || Number.isNaN(n)) continue;
    let set = daysByType.get(type);
    if (!set) {
      set = new Set();
      daysByType.set(type, set);
    }
    set.add(n);
    const prevLast = lastByType.get(type);
    if (!prevLast || date.localeCompare(prevLast) > 0) lastByType.set(type, date);
  }

  const out: StreakInfo[] = [];
  for (const [type, set] of daysByType) {
    const sorted = [...set].sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    let prev = NaN;
    for (const n of sorted) {
      run = n === prev + 1 ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = n;
    }
    // Current run: walk back from the last day while days are contiguous.
    const last = sorted[sorted.length - 1];
    let current = 0;
    if (last !== undefined) {
      let d = last;
      while (set.has(d)) {
        current += 1;
        d -= 1;
      }
    }
    out.push({ type, current, longest, lastDate: lastByType.get(type) ?? null });
  }
  return out.sort(
    (a, b) => b.current - a.current || b.longest - a.longest || a.type.localeCompare(b.type),
  );
}
