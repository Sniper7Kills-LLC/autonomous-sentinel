'use client';

import { useEffect, useState } from 'react';
import { listAggregate, type AggregateRow } from '@/lib/stats/aggregates';

interface AggregateState {
  rows: AggregateRow[];
  loading: boolean;
  error: string | null;
}

/**
 * Session cache of fetched aggregate partitions, keyed by metric (#780).
 *
 * Each Stats page mounts fresh hooks; caching the resolved counter rows for
 * the session makes revisits render synchronously instead of reflashing the
 * loading state. Errors are never cached, so a failed load retries next mount.
 */
const cache = new Map<string, AggregateRow[]>();

/** Drop the cached partitions — used by tests between fixtures. */
export function clearStatsCache(): void {
  cache.clear();
}

/**
 * Read a precomputed `ChartAggregate` metric partition (#780).
 *
 * The corpus aggregation is precomputed server-side (event-driven inline +
 * nightly recompute), so this is a single `list({ metric })` Query — no raw
 * Messages pulled, no client-side corpus aggregation, full-corpus accuracy.
 */
export function useChartAggregate(metric: string): AggregateState {
  const [state, setState] = useState<AggregateState>(() =>
    cache.has(metric)
      ? { rows: cache.get(metric) as AggregateRow[], loading: false, error: null }
      : { rows: [], loading: true, error: null },
  );

  useEffect(() => {
    const cached = cache.get(metric);
    if (cached) {
      setState({ rows: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ rows: [], loading: true, error: null });
    void listAggregate(metric)
      .then((rows) => {
        cache.set(metric, rows);
        if (!cancelled) setState({ rows, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            rows: [],
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [metric]);

  return state;
}
