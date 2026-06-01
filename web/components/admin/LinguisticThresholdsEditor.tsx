'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { MESSAGE_TYPES, type MessageType } from '@/lib/messages/filters';
import { getLinguisticConfig, upsertLinguisticConfig } from '@/lib/admin/linguistic';
import {
  THRESHOLDS_KEY,
  DEFAULT_THRESHOLD,
  clampThreshold,
  normalizeThresholds,
  type ThresholdMap,
} from '@/lib/admin/linguisticConfig';
import styles from './AdminLinguistic.module.css';

/**
 * Per-message-type confidence threshold editor (#110).
 *
 * Loads the `thresholds` LinguisticConfig row, renders one slider +
 * numeric input per MessageType (default 0.8, clamped 0..1), and saves
 * the whole map back as that row's `value`. The Lambda picks the new
 * thresholds up on its next cache refresh.
 *
 * Deferred: per-mutation AuditLog diff (#479).
 */
export function LinguisticThresholdsEditor() {
  const [values, setValues] = useState<ThresholdMap>(() => normalizeThresholds(undefined));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setValues(normalizeThresholds(await getLinguisticConfig(THRESHOLDS_KEY)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load thresholds.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setOne = useCallback((type: MessageType, raw: number) => {
    setStatus(null);
    setValues((prev) => ({ ...prev, [type]: clampThreshold(raw) }));
  }, []);

  const resetOne = useCallback((type: MessageType) => {
    setStatus(null);
    setValues((prev) => ({ ...prev, [type]: DEFAULT_THRESHOLD }));
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await upsertLinguisticConfig(THRESHOLDS_KEY, values, 'Threshold edit via admin UI');
      setStatus('Saved. The Linguistic Logic Lambda picks it up on its next cache refresh.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save thresholds.');
    } finally {
      setBusy(false);
    }
  }, [values]);

  return (
    <section className={styles.section} aria-labelledby="thresholds-heading">
      <header className={styles.sectionHead}>
        <h2 id="thresholds-heading" className={styles.sectionTitle}>
          Confidence thresholds
        </h2>
        <span className={styles.eyebrow}>key · {THRESHOLDS_KEY}</span>
      </header>
      <p className={styles.muted}>
        Per-message-type confidence threshold. A parsed Message at/above its type&apos;s threshold
        auto-publishes clean; below it auto-publishes flagged for review. Default{' '}
        {DEFAULT_THRESHOLD}; clamped to 0–1.
      </p>

      {loading ? (
        <p className={styles.muted} role="status">
          Loading thresholds…
        </p>
      ) : (
        <ul className={styles.list} data-testid="thresholds-list">
          {MESSAGE_TYPES.map((type) => {
            const value = values[type];
            return (
              <li key={type} className={styles.row}>
                <div className={styles.rowBody}>
                  <span className={styles.idMono}>{type}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={value}
                    aria-label={`${type} threshold slider`}
                    data-testid={`threshold-slider-${type}`}
                    onChange={(e) => setOne(type, Number(e.target.value))}
                  />
                </div>
                <div className={styles.rowRight}>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={value}
                    className={styles.input}
                    aria-label={`${type} threshold value`}
                    data-testid={`threshold-input-${type}`}
                    onChange={(e) => setOne(type, Number(e.target.value))}
                  />
                  <Button variant="ghost" size="sm" onClick={() => resetOne(type)}>
                    Reset
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.editorActions}>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          disabled={busy || loading}
          onClick={() => void save()}
        >
          Save thresholds
        </Button>
      </div>

      {status && (
        <p className={styles.statusOk} role="status">
          {status}
        </p>
      )}
      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
