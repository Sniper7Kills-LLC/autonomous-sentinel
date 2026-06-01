'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  listModerationQueue,
  filterBySource,
  setQueueCommentHidden,
  clearMessageFlag,
  resolveAbuseReport,
  type QueueItem,
  type SourceFilter,
} from '@/lib/admin/moderation';
import styles from './ModerationQueue.module.css';

/**
 * Unified moderation queue (#118).
 *
 * Aggregates the flag / report surfaces that have a server-side path
 * today — open AbuseReports, flagged Comments, and Messages with
 * `flaggedForReview = true` — into one oldest-first list with a
 * source filter and per-row actions. Every action rides a grant the
 * mod/admin role already holds:
 *   - comment   → hide (setCommentHidden / Comment.update)
 *   - message   → clear flag (Message.update)
 *   - report    → mark resolved (AbuseReport.update)
 *
 * Deferred actions (delete, ban, add-to-wordlist) and the
 * TranscriptRevision surface have no grantable path yet and are NOT
 * faked — see the footnote rendered below + `lib/admin/moderation.ts`.
 */

const FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'ABUSE_REPORT', label: 'Reports' },
  { value: 'COMMENT', label: 'Comments' },
  { value: 'MESSAGE', label: 'Messages' },
];

export function ModerationQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SourceFilter>('ALL');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listModerationQueue());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the moderation queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => filterBySource(items, filter), [items, filter]);

  const act = useCallback(async (item: QueueItem, run: () => Promise<void>) => {
    setBusyKey(item.key);
    setError(null);
    try {
      await run();
      // Resolved rows drop off the queue.
      setItems((prev) => prev.filter((i) => i.key !== item.key));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusyKey(null);
    }
  }, []);

  return (
    <section className={styles.queue} aria-labelledby="mod-queue-heading">
      <div className={styles.toolbar}>
        <div
          className={styles.filterGroup}
          role="group"
          aria-label="Filter queue by source"
          id="mod-queue-heading"
        >
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              className={`${styles.filterChip} ${
                filter === f.value ? styles.filterChipActive : ''
              }`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className={styles.count} aria-live="polite">
          {visible.length} pending
        </span>
      </div>

      {loading ? (
        <p className={styles.muted} role="status">
          Loading queue…
        </p>
      ) : (
        <ul className={styles.list} data-testid="mod-queue-list">
          {visible.length === 0 ? (
            <li className={styles.empty}>Nothing in the queue.</li>
          ) : (
            visible.map((item) => (
              <li key={item.key} className={styles.row}>
                <div className={styles.rowBody}>
                  <div className={styles.rowMeta}>
                    <Badge tone="warn">{item.sourceLabel}</Badge>
                    {item.reason && <Badge tone="neutral">{item.reason}</Badge>}
                  </div>
                  <p className={styles.summary}>{item.summary}</p>
                  <span className={styles.meta}>
                    {item.reporter && <>reported by {item.reporter} · </>}
                    {item.createdAt ? new Date(item.createdAt).toISOString() : 'no timestamp'}
                    {item.href && (
                      <>
                        {' · '}
                        <Link href={item.href} className={styles.link}>
                          view content →
                        </Link>
                      </>
                    )}
                  </span>
                </div>
                <div className={styles.rowRight}>
                  {item.source === 'COMMENT' && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busyKey === item.key}
                      onClick={() =>
                        void act(item, () => setQueueCommentHidden(item.targetId, true))
                      }
                    >
                      Hide
                    </Button>
                  )}
                  {item.source === 'MESSAGE' && (
                    <Button
                      variant="success"
                      size="sm"
                      disabled={busyKey === item.key}
                      onClick={() => void act(item, () => clearMessageFlag(item.targetId))}
                    >
                      Clear flag
                    </Button>
                  )}
                  {item.source === 'ABUSE_REPORT' && (
                    <>
                      <Button
                        variant="success"
                        size="sm"
                        disabled={busyKey === item.key}
                        onClick={() =>
                          void act(item, () => resolveAbuseReport(item.targetId, 'RESOLVED'))
                        }
                      >
                        Resolve
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyKey === item.key}
                        onClick={() =>
                          void act(item, () => resolveAbuseReport(item.targetId, 'DISMISSED'))
                        }
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))
          )}
        </ul>
      )}

      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}

      <p className={styles.note}>
        Soft-delete, ban (#112), and add-to-wordlist (#93 / #95 / #98) are not wired here yet — no
        server-grantable path exists at v1. Ban opens from the user profile; deletion stays on each
        content surface. Flagged transcript revisions are not surfaced (the model carries no flag
        field).
      </p>
    </section>
  );
}
