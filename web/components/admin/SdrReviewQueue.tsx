'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { listPendingPublicSdrs, reviewSdr, type SdrRow } from '@/lib/sdr';
import styles from './SdrReviewQueue.module.css';

/**
 * Admin SDR review queue (#785).
 *
 * Lists PENDING PUBLIC SDR submissions and allows admins to approve or reject them.
 * Approve → reviewStatus=APPROVED → SDR appears on the public map.
 * Reject  → reviewStatus=REJECTED → SDR hidden from map.
 *
 * Admin-only (this component is rendered behind <AdminGate>).
 */

type DecisionState = { [sdrId: string]: 'approving' | 'rejecting' | null };

export function SdrReviewQueue() {
  const [rows, setRows] = useState<SdrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<DecisionState>({});
  const [noteByRow, setNoteByRow] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listPendingPublicSdrs());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load pending SDR submissions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDecision = useCallback(
    async (sdrId: string, decision: 'APPROVED' | 'REJECTED') => {
      const action = decision === 'APPROVED' ? 'approving' : 'rejecting';
      setBusy((prev) => ({ ...prev, [sdrId]: action }));
      setError(null);
      try {
        await reviewSdr(sdrId, decision, noteByRow[sdrId] ?? undefined);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : `Failed to ${action} SDR.`);
      } finally {
        setBusy((prev) => ({ ...prev, [sdrId]: null }));
      }
    },
    [noteByRow, reload],
  );

  return (
    <section className={styles.queue} aria-labelledby="sdr-review-heading">
      <header className={styles.header}>
        <h2 id="sdr-review-heading" className={styles.title}>
          Pending SDR Submissions
        </h2>
        <Button variant="secondary" size="sm" onClick={() => void reload()} disabled={loading}>
          Refresh
        </Button>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className={styles.muted} role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className={styles.muted}>No pending SDR submissions.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((sdr) => (
            <li key={sdr.id} className={styles.item}>
              <div className={styles.itemHeader}>
                <span className={styles.sdrName}>{sdr.name}</span>
                <span className={styles.badge}>PUBLIC · PENDING</span>
              </div>

              {sdr.url && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>URL:</span>
                  <a
                    href={sdr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.urlLink}
                  >
                    {sdr.url}
                  </a>
                </div>
              )}

              {sdr.latitude !== null && sdr.longitude !== null && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Location:</span>
                  <span className={styles.metaValue}>
                    {sdr.latitude?.toFixed(4)}, {sdr.longitude?.toFixed(4)}
                    {sdr.locationGranularity && ` (${sdr.locationGranularity.toLowerCase()})`}
                  </span>
                </div>
              )}

              {sdr.notes && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Notes:</span>
                  <span className={styles.metaValue}>{sdr.notes}</span>
                </div>
              )}

              {sdr.submitterId && (
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Submitter:</span>
                  <span className={styles.metaMono}>{sdr.submitterId}</span>
                </div>
              )}

              <div className={styles.noteRow}>
                <label htmlFor={`note-${sdr.id}`} className={styles.noteLabel}>
                  Review note (optional)
                </label>
                <input
                  id={`note-${sdr.id}`}
                  className={styles.noteInput}
                  value={noteByRow[sdr.id] ?? ''}
                  onChange={(e) =>
                    setNoteByRow((prev) => ({ ...prev, [sdr.id]: e.target.value }))
                  }
                  placeholder="Reason for approval / rejection…"
                />
              </div>

              <div className={styles.actions}>
                <Button
                  size="sm"
                  loading={busy[sdr.id] === 'approving'}
                  disabled={busy[sdr.id] === 'rejecting'}
                  onClick={() => void handleDecision(sdr.id, 'APPROVED')}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy[sdr.id] === 'rejecting'}
                  disabled={busy[sdr.id] === 'approving'}
                  onClick={() => void handleDecision(sdr.id, 'REJECTED')}
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
