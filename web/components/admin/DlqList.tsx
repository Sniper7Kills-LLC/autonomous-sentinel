'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  listDlqMessages,
  requeueDlqMessage,
  dropDlqMessage,
  PIPELINE_STAGES,
  type PipelineStage,
  type DlqMessageView,
} from '@/lib/dlq/query';
import styles from './DlqList.module.css';

/**
 * Admin DLQ + manual-reprocess view (#107).
 *
 * Per-stage tabs over the three pipeline DLQs (preprocess / transcribe /
 * linguistic). Each row shows the stuck recording, attempt count, time
 * enqueued, and error reason, with per-row Retry (re-queue to the
 * primary queue) + Drop (permanently remove + mark the Recording
 * FAILED) actions. Bulk-select drives Retry-all / Drop-all, both
 * confirmed before firing. A 30s poll refreshes the active stage's
 * counter so an admin watching the page sees the backlog shrink.
 *
 * Every server op is admin-gated (the `(admin)` chrome + AppSync authz);
 * the page only renders for the admin group.
 */

const STAGE_LABELS: Record<PipelineStage, string> = {
  preprocess: 'Pre-process',
  transcribe: 'Transcribe',
  linguistic: 'Linguistic',
};

const POLL_MS = 30_000;

export function DlqList() {
  const [stage, setStage] = useState<PipelineStage>('preprocess');
  const [messages, setMessages] = useState<DlqMessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [errorFilter, setErrorFilter] = useState('');

  // Keep the latest stage in a ref so the interval callback always polls
  // the stage currently on screen without re-arming the timer each switch.
  const stageRef = useRef(stage);
  stageRef.current = stage;

  const load = useCallback(async (target: PipelineStage) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listDlqMessages(target);
      // Only apply if the user has not switched stages mid-flight.
      if (stageRef.current === target) {
        setMessages(rows);
        setSelected(new Set());
      }
    } catch (e) {
      if (stageRef.current === target) {
        setError(e instanceof Error ? e.message : 'Failed to load the DLQ.');
      }
    } finally {
      if (stageRef.current === target) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(stage);
  }, [stage, load]);

  // Live counter — re-peek the active stage every 30s.
  useEffect(() => {
    const id = setInterval(() => {
      void load(stageRef.current);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const visible = useMemo(() => {
    const f = errorFilter.trim().toLowerCase();
    if (!f) return messages;
    return messages.filter(
      (m) =>
        (m.errorReason ?? '').toLowerCase().includes(f) ||
        (m.recordingId ?? '').toLowerCase().includes(f) ||
        m.body.toLowerCase().includes(f),
    );
  }, [messages, errorFilter]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allVisibleSelected = visible.length > 0 && visible.every((m) => selected.has(m.messageId));
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (visible.every((m) => prev.has(m.messageId))) return new Set();
      return new Set(visible.map((m) => m.messageId));
    });
  }, [visible]);

  const runAction = useCallback(async (targets: DlqMessageView[], action: 'requeue' | 'drop') => {
    if (targets.length === 0) return;
    setBusy(true);
    setError(null);
    const done = new Set<string>();
    try {
      for (const m of targets) {
        if (action === 'requeue') await requeueDlqMessage(m);
        else await dropDlqMessage(m);
        done.add(m.messageId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      // Drop actioned rows from the list regardless of a mid-batch error
      // (the ones that succeeded are gone from the DLQ).
      setMessages((prev) => prev.filter((m) => !done.has(m.messageId)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of done) next.delete(id);
        return next;
      });
      setBusy(false);
    }
  }, []);

  const selectedMessages = useMemo(
    () => visible.filter((m) => selected.has(m.messageId)),
    [visible, selected],
  );

  const confirmAndRun = useCallback(
    (targets: DlqMessageView[], action: 'requeue' | 'drop') => {
      const verb = action === 'requeue' ? 'Re-queue' : 'Permanently drop';
      const noun = targets.length === 1 ? 'this message' : `${targets.length} messages`;
      const extra =
        action === 'drop'
          ? ' Their recordings will be marked FAILED and cannot be auto-retried.'
          : '';
      if (typeof window !== 'undefined' && !window.confirm(`${verb} ${noun}?${extra}`)) return;
      void runAction(targets, action);
    },
    [runAction],
  );

  return (
    <section className={styles.dlq} aria-labelledby="dlq-heading">
      <div className={styles.tabs} role="tablist" aria-label="Pipeline stage" id="dlq-heading">
        {PIPELINE_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={stage === s}
            className={`${styles.tab} ${stage === s ? styles.tabActive : ''}`}
            onClick={() => setStage(s)}
          >
            {STAGE_LABELS[s]}
            {stage === s ? <span className={styles.tabCount}>{messages.length}</span> : null}
          </button>
        ))}
      </div>

      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.filter}
          placeholder="Filter by error / recording id…"
          value={errorFilter}
          onChange={(e) => setErrorFilter(e.target.value)}
          aria-label="Filter messages"
        />
        <span className={styles.count} aria-live="polite">
          {loading ? 'Loading…' : `${visible.length} of ${messages.length} shown`}
        </span>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {selectedMessages.length > 0 ? (
        <div className={styles.bulkBar}>
          <span>{selectedMessages.length} selected</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => confirmAndRun(selectedMessages, 'requeue')}
          >
            Retry selected
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => confirmAndRun(selectedMessages, 'drop')}
          >
            Drop selected
          </Button>
        </div>
      ) : null}

      {loading ? (
        <p className={styles.muted} role="status">
          Peeking the {STAGE_LABELS[stage]} DLQ…
        </p>
      ) : visible.length === 0 ? (
        <p className={styles.empty}>No stuck messages on the {STAGE_LABELS[stage]} DLQ. 🎉</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.checkCol}>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all visible messages"
                />
              </th>
              <th scope="col">Recording</th>
              <th scope="col">Attempts</th>
              <th scope="col">Enqueued</th>
              <th scope="col">Error</th>
              <th scope="col" className={styles.actionsCol}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <tr key={m.messageId} className={styles.row}>
                <td className={styles.checkCol}>
                  <input
                    type="checkbox"
                    checked={selected.has(m.messageId)}
                    onChange={() => toggle(m.messageId)}
                    aria-label={`Select message ${m.messageId}`}
                  />
                </td>
                <td>
                  {m.recordingId ? (
                    <code className={styles.recId}>{m.recordingId}</code>
                  ) : (
                    <span className={styles.muted}>—</span>
                  )}
                </td>
                <td>
                  <Badge tone={m.approximateReceiveCount >= 3 ? 'danger' : 'warn'}>
                    {m.approximateReceiveCount}
                  </Badge>
                </td>
                <td className={styles.muted}>
                  {m.enqueuedAt ? new Date(m.enqueuedAt).toLocaleString() : '—'}
                </td>
                <td className={styles.errorCell} title={m.errorReason ?? undefined}>
                  {m.errorReason ?? <span className={styles.muted}>—</span>}
                </td>
                <td className={styles.actionsCol}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => confirmAndRun([m], 'requeue')}
                  >
                    Retry
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => confirmAndRun([m], 'drop')}
                  >
                    Drop
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
