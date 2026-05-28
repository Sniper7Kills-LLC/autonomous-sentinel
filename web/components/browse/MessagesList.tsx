'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { listMessages } from '@/lib/messages/query';
import { parseFiltersFromParams, type MessageFilters } from '@/lib/messages/filters';
import type { DisplayMessage } from '@/lib/messages/types';
import { MessageCard } from './MessageCard';
import styles from './MessagesList.module.css';

const PAGE_SIZE = 25;

export interface MessagesListProps {
  /** Forces a `type` filter regardless of URL params (used by /skykings, /skybird). */
  forcedType?: MessageFilters['type'];
  /** Caps total items shown — used by landing-page latest-feed snippet. */
  limit?: number;
  /** Hide the "Load more" button (used when `limit` is intentionally small). */
  hideLoadMore?: boolean;
}

export function MessagesList({ forcedType, limit, hideLoadMore }: MessagesListProps) {
  const searchParams = useSearchParams();
  const urlFilters = useMemo(
    () => parseFiltersFromParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const filters = useMemo<MessageFilters>(
    () => (forcedType ? { ...urlFilters, type: forcedType } : urlFilters),
    [urlFilters, forcedType],
  );

  const [items, setItems] = useState<DisplayMessage[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (token: string | null) => {
      try {
        if (!token) setLoading(true);
        else setLoadingMore(true);
        setError(null);
        const result = await listMessages({
          filters,
          nextToken: token,
          pageSize: PAGE_SIZE,
        });
        setItems((prev) => {
          const merged = token ? [...prev, ...result.items] : result.items;
          return limit ? merged.slice(0, limit) : merged;
        });
        setNextToken(
          limit && (token ? items.length + result.items.length : result.items.length) >= limit
            ? null
            : result.nextToken,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [filters, limit, items.length],
  );

  useEffect(() => {
    // Re-fetch every time filters change. `load` is included so
    // the hook stays exhaustive without a per-call disable; it
    // depends on `filters` + `limit` + `items.length`, which is
    // fine because the effect only fires on real filter changes
    // (other deps are stable across renders).
    void load(null);
  }, [load, filters.type, filters.from, filters.to, filters.sender, filters.receiver]);

  if (loading) {
    return (
      <div className={styles.skeleton} aria-busy aria-label="Loading messages">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={styles.skeletonRow} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.error} role="alert">
        Could not load messages: {error}
      </div>
    );
  }

  if (items.length === 0) {
    return <div className={styles.empty}>No messages match these filters.</div>;
  }

  return (
    <>
      <div className={styles.list}>
        {items.map((m) => (
          <MessageCard key={m.id} message={m} />
        ))}
      </div>
      {!hideLoadMore && nextToken && (
        <div className={styles.loadMoreRow}>
          <Button
            variant="ghost"
            onClick={() => {
              void load(nextToken);
            }}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load more
          </Button>
        </div>
      )}
    </>
  );
}
