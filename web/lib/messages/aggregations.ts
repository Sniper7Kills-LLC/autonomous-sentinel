import type { DisplayMessage } from './types';

/**
 * Pure aggregation helpers consumed by the stats section charts (#80, #81, #82).
 *
 * The Stats page fetches Messages via `listMessages` and feeds them through
 * these helpers — keeping all chart math out of React renders so the
 * transforms can be unit-tested without spinning up a DOM.
 */

export type DailyCountBucket = {
  date: string; // YYYY-MM-DD UTC
  count: number;
};

export function aggregateDailyCounts(
  messages: Pick<DisplayMessage, 'broadcastTs'>[],
): DailyCountBucket[] {
  const map = new Map<string, number>();
  for (const m of messages) {
    if (!m.broadcastTs) continue;
    const d = new Date(m.broadcastTs);
    if (Number.isNaN(d.getTime())) continue;
    const date = d.toISOString().slice(0, 10);
    map.set(date, (map.get(date) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type CountHistogramBucket = {
  value: number;
  count: number;
};

/**
 * Histogram of an integer-valued field across the Messages set. Used for
 * character-count + codeword-count distributions.
 */
export function aggregateValueHistogram<K extends keyof DisplayMessage>(
  messages: DisplayMessage[],
  field: K,
): CountHistogramBucket[] {
  const map = new Map<number, number>();
  for (const m of messages) {
    const v = m[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    map.set(v, (map.get(v) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value - b.value);
}
