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
 * Load up to `limit` recent Messages for client-side aggregation.
 * Each chart consumes the same payload — keeps the AppSync hit-count
 * to one regardless of which chart variant the page renders.
 */
export function useStatsMessages(limit = 500): StatsLoaderState {
  const [state, setState] = useState<StatsLoaderState>({
    messages: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
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
        if (!cancelled) {
          setState({ messages: collected.slice(0, limit), loading: false, error: null });
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
