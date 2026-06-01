'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  getReputationConfig,
  saveReputationConfig,
  validateReputationConfig,
  valuesToFormValues,
  computeWeight,
  DEFAULT_FORM_VALUES,
  DEFAULT_REPUTATION_CONFIG,
  type ReputationConfigValues,
  type ReputationFormValues,
  type ReputationFieldErrors,
  type UserRole,
} from '@/lib/admin/reputation-config';
import styles from './ReputationConfigEditor.module.css';

/**
 * Admin reputation / vote-weight formula tuning editor (#117).
 *
 * Loads the singleton `ReputationConfig` "default" row (seeded with the
 * CLAUDE.md defaults when absent), one numeric input per coefficient, a
 * Save (upsert — create on first save, update thereafter), and a live
 * preview pane computing an example weight for a sample user via the pure
 * `computeWeight` formula using the CURRENT form values.
 *
 * Create/update is gated to the `admin` Cognito group server-side; this
 * component renders behind `<AdminGate>`. The server enforces
 * authorization regardless.
 *
 * The recompute-on-publish/accept Lambda that APPLIES this formula to
 * Reputation rows is #480 — out of scope here.
 */

/** Editable coefficients in display order, with field-level metadata. */
const FIELDS: { key: keyof ReputationConfigValues; label: string; step: string; hint?: string }[] =
  [
    { key: 'base', label: 'Base weight', step: '0.1', hint: 'Starting weight for every user.' },
    {
      key: 'perValidatedSubmission',
      label: 'Per validated submission',
      step: '0.01',
      hint: 'Added per recording that produced a successful Message.',
    },
    { key: 'validatedCap', label: 'Validated submission cap', step: '1', hint: 'Max counted.' },
    {
      key: 'perAcceptedCorrection',
      label: 'Per accepted correction',
      step: '0.01',
      hint: 'Added per revision adopted by majority.',
    },
    { key: 'correctionCap', label: 'Accepted correction cap', step: '1', hint: 'Max counted.' },
    { key: 'moderatorBonus', label: 'Moderator bonus', step: '0.1' },
    { key: 'adminBonus', label: 'Admin bonus', step: '0.1' },
    {
      key: 'netWeightCap',
      label: 'Net weight cap',
      step: '0.1',
      hint: 'Hard ceiling on the final weight.',
    },
    {
      key: 'quorum',
      label: 'Quorum (revision adoption)',
      step: '0.1',
      hint: 'Minimum total weighted score to adopt a revision.',
    },
    {
      key: 'confidenceThreshold',
      label: 'Confidence threshold',
      step: '0.05',
      hint: 'Auto-publish-clean vs flag-for-review (0–1).',
    },
  ];

const ROLES: UserRole[] = ['member', 'moderator', 'admin'];

export function ReputationConfigEditor() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);

  const [form, setForm] = useState<ReputationFormValues>(DEFAULT_FORM_VALUES);
  const [notes, setNotes] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ReputationFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sample-user inputs for the preview pane.
  const [sampleSubs, setSampleSubs] = useState('10');
  const [sampleCorr, setSampleCorr] = useState('3');
  const [sampleRole, setSampleRole] = useState<UserRole>('member');

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const row = await getReputationConfig();
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
      setError(e instanceof Error ? e.message : 'Failed to load reputation config.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setField = (key: keyof ReputationConfigValues, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const resetDefaults = () => {
    setForm(DEFAULT_FORM_VALUES);
    setFieldErrors({});
    setSaved(false);
  };

  const onSave = async () => {
    const { errors, input } = validateReputationConfig(form);
    setFieldErrors(errors);
    if (!input) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const row = await saveReputationConfig(input, { exists, notes });
      setExists(true);
      const { key: _k, notes: rowNotes, updatedAt: _u, ...values } = row;
      setForm(valuesToFormValues(values));
      setNotes(rowNotes);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save reputation config.');
    } finally {
      setSaving(false);
    }
  };

  // Live preview: compute the sample weight from the CURRENT form values.
  // When the form does not parse, fall back to CLAUDE.md defaults so the
  // pane still shows a number while the operator is mid-edit.
  const previewWeight = useMemo(() => {
    const { input } = validateReputationConfig(form);
    const cfg = input ?? DEFAULT_REPUTATION_CONFIG;
    const subs = Number(sampleSubs);
    const corr = Number(sampleCorr);
    return computeWeight(cfg, {
      validatedSubmissions: Number.isFinite(subs) ? subs : 0,
      acceptedCorrections: Number.isFinite(corr) ? corr : 0,
      role: sampleRole,
    });
  }, [form, sampleSubs, sampleCorr, sampleRole]);

  if (loading) {
    return (
      <p className={styles.muted} role="status">
        Loading reputation config…
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
      <div className={styles.layout}>
        <section className={styles.form} aria-labelledby="rep-form-title">
          <h2 id="rep-form-title" className={styles.formTitle}>
            Formula coefficients
          </h2>
          <div className={styles.grid}>
            {FIELDS.map((f) => {
              const id = `rep-${f.key}`;
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
            <label className={styles.label} htmlFor="rep-notes">
              Notes
            </label>
            <textarea
              id="rep-notes"
              className={styles.textarea}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setSaved(false);
              }}
              placeholder="Optional — why these values were chosen."
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

        <aside className={styles.previewPane} aria-labelledby="rep-preview-title">
          <h2 id="rep-preview-title" className={styles.previewTitle}>
            Live preview
          </h2>
          <p className={styles.muted}>
            Example weight for a sample user, computed from the values above.
          </p>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="rep-sample-subs">
              Validated submissions
            </label>
            <input
              id="rep-sample-subs"
              className={styles.input}
              type="number"
              step="1"
              value={sampleSubs}
              onChange={(e) => setSampleSubs(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="rep-sample-corr">
              Accepted corrections
            </label>
            <input
              id="rep-sample-corr"
              className={styles.input}
              type="number"
              step="1"
              value={sampleCorr}
              onChange={(e) => setSampleCorr(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="rep-sample-role">
              Role
            </label>
            <select
              id="rep-sample-role"
              className={styles.input}
              value={sampleRole}
              onChange={(e) => setSampleRole(e.target.value as UserRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className={styles.weightLabel}>Computed weight</div>
            <div className={styles.weight} data-testid="preview-weight">
              {previewWeight.toFixed(2)}
            </div>
          </div>
        </aside>
      </div>

      <p className={styles.deferNote}>
        Saving updates the formula configuration. Applying it to existing user reputation rows
        (recompute on publish / accept) is tracked separately in #480.
      </p>
    </div>
  );
}
