'use client';

import { useEffect, useState } from 'react';
import { listMessages } from '@/lib/messages/query';
import type { DisplayMessage, ListResult } from '@/lib/messages/types';

interface StatsLoaderState {
  messages: DisplayMessage[];
  loading: boolean;
  error: string | null;
}

/**
 * In-memory cache of fetched stats payloads, keyed by `limit` (#726).
 *
 * Each Stats page (overview + the three drill-downs) mounts a fresh
 * `useStatsMessages`, so without a cache every navigation re-ran the
 * AppSync paging loop and flashed the loading placeholders — reading
 * like a full app refresh. Caching the resolved payload for the session
 * makes revisits render synchronously. Errors are never cached, so a
 * failed load still retries on the next mount.
 */
const cache = new Map<number, DisplayMessage[]>();

/** Drop the cached payloads — used by tests between fixtures. */
export function clearStatsCache(): void {
  cache.clear();
}

/**
 * Load up to `limit` recent Messages for client-side aggregation.
 * Each chart consumes the same payload — keeps the AppSync hit-count
 * to one regardless of which chart variant the page renders.
 */
export function useStatsMessages(limit = 500): StatsLoaderState {
  const [state, setState] = useState<StatsLoaderState>(() =>
    cache.has(limit)
      ? { messages: cache.get(limit) as DisplayMessage[], loading: false, error: null }
      : { messages: [], loading: true, error: null },
  );

  useEffect(() => {
    // Cached payload for this limit — serve it synchronously and skip
    // the network round-trip entirely.
    const cached = cache.get(limit);
    if (cached) {
      setState({ messages: cached, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ messages: [], loading: true, error: null });
    let collected: DisplayMessage[] = [];
    let nextToken: string | null = null;
    void (async () => {
      try {
        do {
          const page: ListResult = await listMessages({
            pageSize: Math.min(100, limit - collected.length),
            nextToken,
          });
          collected = collected.concat(page.items);
          nextToken = page.nextToken;
          if (collected.length >= limit) break;
        } while (nextToken);
        const messages = collected.slice(0, limit);
        cache.set(limit, messages);
        if (!cancelled) {
          setState({ messages, loading: false, error: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            messages: [],
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [limit]);

  return state;
}
