import type { DisplayMessage } from './types';

/**
 * Pure aggregation helpers consumed by the stats section charts.
 *
 * The Stats page fetches Messages via `listMessages` and feeds them through
 * these helpers — keeping all chart math out of React renders so the
 * transforms can be unit-tested without spinning up a DOM.
 *
 * Character/codeword *frequency* aggregations live in `@/lib/stats/frequency`
 * (#499 / #500). The old per-row count histogram was removed alongside the
 * `characterCount` / `codewordCount` field drop (#501).
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
