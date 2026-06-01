'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  getPlaybackConfig,
  savePlaybackConfig,
  validatePlaybackConfig,
  valuesToFormValues,
  DEFAULT_FORM_VALUES,
  type PlaybackConfigValues,
  type PlaybackFormValues,
  type PlaybackFieldErrors,
} from '@/lib/admin/playback-config';
import styles from './PlaybackConfigEditor.module.css';

/**
 * Admin playback rate-limit tuning editor (#114).
 *
 * Loads the singleton `PlaybackConfig` "default" row (seeded with the
 * defaults when absent), one numeric input per per-IP knob, and a Save
 * (upsert — create on first save, update thereafter).
 *
 * Create/update is gated to the `admin` Cognito group server-side; this
 * component renders behind `<AdminGate>`. The server enforces
 * authorization regardless.
 *
 * The signed-URL / CloudFront edge enforcement that READS this config is
 * phase 6 work (#205 / WAF) — out of scope here.
 *
 * STATS dashboards (most-played audio, top-playing users, throttle-event
 * counts, bytes-served sparkline) are DEFERRED: they need playback
 * counters emitted by the playback / signed-URL pipeline, which does not
 * exist yet (#91 / #205). A placeholder section stands in until then — no
 * fabricated numbers.
 */

const FIELDS: {
  key: keyof PlaybackConfigValues;
  label: string;
  step: string;
  hint?: string;
}[] = [
  {
    key: 'requestsPerMinute',
    label: 'Requests per minute (per IP)',
    step: '1',
    hint: 'Max signed-URL / playback requests an IP may make each minute.',
  },
  {
    key: 'bytesPerHour',
    label: 'Bytes per hour (per IP)',
    step: '1',
    hint: 'Bandwidth budget per IP each hour. Default 1073741824 = 1 GiB.',
  },
  {
    key: 'signedUrlTtlSeconds',
    label: 'Signed-URL TTL (seconds)',
    step: '1',
    hint: 'Playback URL lifetime. 30–3600s.',
  },
];

export function PlaybackConfigEditor() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);

  const [form, setForm] = useState<PlaybackFormValues>(DEFAULT_FORM_VALUES);
  const [notes, setNotes] = useState('');
  const [fieldErrors, setFieldErrors] = useState<PlaybackFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const row = await getPlaybackConfig();
      if (row) {
        setExists(true);
        const { key: _k, notes: rowNotes, updatedAt: _u, ...values } = row;
        setForm(valuesToFormValues(values));
        setNotes(rowNotes);
      } else {
        setExists(false);
        setForm(DEFAULT_FORM_VALUES);
        setNotes('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load playback config.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setField = (key: keyof PlaybackConfigValues, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const resetDefaults = () => {
    setForm(DEFAULT_FORM_VALUES);
    setFieldErrors({});
    setSaved(false);
  };

  const onSave = async () => {
    const { errors, input } = validatePlaybackConfig(form);
    setFieldErrors(errors);
    if (!input) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const row = await savePlaybackConfig(input, { exists, notes });
      setExists(true);
      const { key: _k, notes: rowNotes, updatedAt: _u, ...values } = row;
      setForm(valuesToFormValues(values));
      setNotes(rowNotes);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save playback config.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <p className={styles.muted} role="status">
        Loading playback config…
      </p>
    );
  }

  return (
    <div className={styles.editor}>
      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}

      <section className={styles.form} aria-labelledby="pb-form-title">
        <h2 id="pb-form-title" className={styles.formTitle}>
          Per-IP rate limits
        </h2>
        <div className={styles.grid}>
          {FIELDS.map((f) => {
            const id = `pb-${f.key}`;
            const err = fieldErrors[f.key];
            return (
              <div key={f.key} className={styles.field}>
                <label className={styles.label} htmlFor={id}>
                  {f.label}
                </label>
                <input
                  id={id}
                  className={styles.input}
                  type="number"
                  step={f.step}
                  value={form[f.key]}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `${id}-err` : f.hint ? `${id}-hint` : undefined}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
                {f.hint && !err && (
                  <span id={`${id}-hint`} className={styles.hint}>
                    {f.hint}
                  </span>
                )}
                {err && (
                  <span id={`${id}-err`} className={styles.fieldError}>
                    {err}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="pb-notes">
            Notes
          </label>
          <textarea
            id="pb-notes"
            className={styles.textarea}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setSaved(false);
            }}
            placeholder="Optional — why these limits were chosen."
          />
        </div>

        <div className={styles.formActions}>
          <Button onClick={() => void onSave()} loading={saving}>
            Save
          </Button>
          <Button variant="ghost" onClick={resetDefaults} disabled={saving} type="button">
            Reset to defaults
          </Button>
          {saved && (
            <span className={styles.statusOk} role="status">
              Saved.
            </span>
          )}
        </div>
      </section>

      <section className={styles.statsPlaceholder} aria-labelledby="pb-stats-title">
        <h2 id="pb-stats-title" className={styles.statsTitle}>
          Playback stats
        </h2>
        <p className={styles.muted}>
          Most-played audio, top-playing users, throttle-event counts, and bytes-served charts land
          once the playback / signed-URL pipeline emits playback counters (#91 / #205). No stats are
          shown yet — this section is intentionally empty rather than fabricated.
        </p>
      </section>

      <p className={styles.deferNote}>
        Saving updates the rate-limit configuration. Enforcing it at the CloudFront / signed-URL
        edge is tracked separately in #205 (phase 6).
      </p>
    </div>
  );
}
