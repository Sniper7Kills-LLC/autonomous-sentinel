'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { searchMessages, type SearchFilters } from '@/lib/messages/search';
import { parseFiltersFromParams } from '@/lib/messages/filters';
import type { DisplayMessage } from '@/lib/messages/types';
import { SearchResultCard } from './SearchResultCard';
import styles from './SearchResults.module.css';

const PAGE_SIZE = 25;

/**
 * Best-effort full-text search surface (#87). Reads `?q=` (+ the
 * browse `?type=`/`?from=`/`?to=` filters) from the URL, runs
 * `searchMessages`, and renders highlighted hits with `nextToken`
 * pagination.
 *
 * v1 deviation from the issue: search is driven client-side off the
 * existing `Message.list` `contains` filter — no AppSync custom query
 * / Lambda resolver — which keeps the static export intact. The
 * OpenSearch migration (#182) supersedes the backend without changing
 * this UI.
 */
export function SearchResults() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = (searchParams.get('q') ?? '').trim();
  const filters = useMemo<SearchFilters>(() => {
    const parsed = parseFiltersFromParams(new URLSearchParams(searchParams.toString()));
    return { type: parsed.type, from: parsed.from, to: parsed.to };
  }, [searchParams]);

  const [draft, setDraft] = useState(q);
  const [items, setItems] = useState<DisplayMessage[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  // Keep the input in sync when the URL `q` changes (e.g. header search).
  useEffect(() => setDraft(q), [q]);

  const load = useCallback(
    async (token: string | null) => {
      if (!q) {
        setItems([]);
        setNextToken(null);
        setSearched(false);
        return;
      }
      try {
        if (!token) setLoading(true);
        else setLoadingMore(true);
        setError(null);
        const result = await searchMessages(q, {
          ...filters,
          nextToken: token,
          pageSize: PAGE_SIZE,
        });
        setItems((prev) => (token ? [...prev, ...result.items] : result.items));
        setNextToken(result.nextToken);
        setSearched(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [q, filters],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(searchParams.toString());
    const value = draft.trim();
    if (value) next.set('q', value);
    else next.delete('q');
    router.replace(`/search?${next.toString()}`);
  };

  return (
    <div className={styles.wrap}>
      <Alert tone="info" title="Best-effort search">
        Search is best-effort and may be slow on rare terms — a faster index is coming (
        <a
          href="https://github.com/Sniper7Kills-LLC/autonomous-sentinel/issues/182"
          target="_blank"
          rel="noreferrer"
        >
          #182
        </a>
        ).
      </Alert>

      <form className={styles.form} role="search" aria-label="Search messages" onSubmit={onSubmit}>
        <input
          className={styles.input}
          type="search"
          aria-label="Search query"
          placeholder="Search transcripts, callsigns…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      {loading && (
        <div className={styles.skeleton} aria-busy aria-label="Searching">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={styles.skeletonRow} />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className={styles.error} role="alert">
          Search failed: {error}
        </div>
      )}

      {!loading && !error && q && searched && items.length === 0 && (
        <div className={styles.empty}>
          No results for “{q}”. Try a shorter term, fewer filters, or a different spelling.
        </div>
      )}

      {!loading && !error && !q && (
        <div className={styles.empty}>Enter a search term above to query the archive.</div>
      )}

      {!loading && !error && items.length > 0 && (
        <>
          <div className={styles.list}>
            {items.map((m) => (
              <SearchResultCard key={m.id} message={m} query={q} />
            ))}
          </div>
          {nextToken && (
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
      )}
    </div>
  );
}
