'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  getBudgetConfig,
  saveBudgetConfig,
  validateBudgetConfig,
  valuesToFormValues,
  DEFAULT_FORM_VALUES,
  type BudgetFormValues,
  type BudgetFieldErrors,
  type BudgetActions,
} from '@/lib/admin/budget-config';
import styles from './BudgetConfigEditor.module.css';

/**
 * Admin AWS Budget threshold tuning editor (#116).
 *
 * Loads the singleton `BudgetConfig` "default" row (seeded with the
 * CLAUDE.md $50/$100/$200 defaults when absent), one input per threshold +
 * a notification email + per-tier action toggles, and a Save (upsert — create
 * on first save, update thereafter).
 *
 * Validation mirrors the CDK invariant in `amplify/budgets.ts`: positive
 * integer thresholds, soft < loud < hard, valid notification email.
 *
 * Honest framing (see the defer note in the rendered UI): editing only
 * RECORDS the intended values. Pushing them into the `AS_BUDGET_*` env vars +
 * redeploying (the sync step) and live month-to-date spend display (Cost
 * Explorer, #303) are both DEFERRED. This component renders behind
 * `<AdminGate>`; the AppSync model enforces admin-only authz regardless.
 */

const THRESHOLD_FIELDS: { key: 'softUsd' | 'loudUsd' | 'hardUsd'; label: string; hint: string }[] =
  [
    { key: 'softUsd', label: 'Soft threshold (USD)', hint: 'Email only. CLAUDE.md default $50.' },
    {
      key: 'loudUsd',
      label: 'Loud threshold (USD)',
      hint: 'Email + admin banner. CLAUDE.md default $100.',
    },
    {
      key: 'hardUsd',
      label: 'Hard threshold (USD)',
      hint: 'Throttle Whisper + page admin. CLAUDE.md default $200.',
    },
  ];

const ACTION_TOGGLES: { key: keyof BudgetActions; label: string }[] = [
  { key: 'softBannerEnabled', label: 'Soft tier — show admin banner' },
  { key: 'loudBannerEnabled', label: 'Loud tier — show admin banner' },
  { key: 'hardThrottleEnabled', label: 'Hard tier — throttle Whisper concurrency' },
  { key: 'hardPageEnabled', label: 'Hard tier — page admin' },
];

export function BudgetConfigEditor() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);

  const [form, setForm] = useState<BudgetFormValues>(DEFAULT_FORM_VALUES);
  const [notes, setNotes] = useState('');
  const [fieldErrors, setFieldErrors] = useState<BudgetFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const row = await getBudgetConfig();
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
      setError(e instanceof Error ? e.message : 'Failed to load budget config.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setField = (key: keyof BudgetFormValues, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const toggle = (key: keyof BudgetActions) => {
    setForm((f) => ({ ...f, [key]: !f[key] }));
    setSaved(false);
  };

  const resetDefaults = () => {
    setForm(DEFAULT_FORM_VALUES);
    setFieldErrors({});
    setSaved(false);
  };

  const onSave = async () => {
    const { errors, input } = validateBudgetConfig(form);
    setFieldErrors(errors);
    if (!input) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const row = await saveBudgetConfig(input, { exists, notes });
      setExists(true);
      const { key: _k, notes: rowNotes, updatedAt: _u, ...values } = row;
      setForm(valuesToFormValues(values));
      setNotes(rowNotes);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save budget config.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <p className={styles.muted} role="status">
        Loading budget config…
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

      <section className={styles.form} aria-labelledby="budget-thresholds-title">
        <h2 id="budget-thresholds-title" className={styles.formTitle}>
          Thresholds
        </h2>
        <div className={styles.grid}>
          {THRESHOLD_FIELDS.map((f) => {
            const id = `budget-${f.key}`;
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
                  step="1"
                  min="1"
                  value={form[f.key]}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `${id}-err` : `${id}-hint`}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
                {!err && (
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
          <label className={styles.label} htmlFor="budget-email">
            Notification email
          </label>
          <input
            id="budget-email"
            className={styles.input}
            type="email"
            value={form.notificationEmail}
            aria-invalid={fieldErrors.notificationEmail ? true : undefined}
            aria-describedby={
              fieldErrors.notificationEmail ? 'budget-email-err' : 'budget-email-hint'
            }
            onChange={(e) => setField('notificationEmail', e.target.value)}
          />
          {!fieldErrors.notificationEmail && (
            <span id="budget-email-hint" className={styles.hint}>
              Recipient for every budget alarm tier.
            </span>
          )}
          {fieldErrors.notificationEmail && (
            <span id="budget-email-err" className={styles.fieldError}>
              {fieldErrors.notificationEmail}
            </span>
          )}
        </div>
      </section>

      <section className={styles.form} aria-labelledby="budget-actions-title">
        <h2 id="budget-actions-title" className={styles.formTitle}>
          Tier actions
        </h2>
        <div className={styles.toggles}>
          {ACTION_TOGGLES.map((t) => {
            const id = `budget-${t.key}`;
            return (
              <label key={t.key} className={styles.toggle} htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={form[t.key]}
                  onChange={() => toggle(t.key)}
                />
                <span>{t.label}</span>
              </label>
            );
          })}
        </div>
      </section>

      <section className={styles.form} aria-labelledby="budget-notes-title">
        <h2 id="budget-notes-title" className={styles.formTitle}>
          Notes
        </h2>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="budget-notes">
            Notes
          </label>
          <textarea
            id="budget-notes"
            className={styles.textarea}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setSaved(false);
            }}
            placeholder="Optional — why these thresholds were chosen."
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

      <p className={styles.deferNote}>
        Editing records the intended thresholds, recipient, and tier actions only. Applying them to
        the LIVE AWS Budget updates the <code>AS_BUDGET_SOFT_USD</code> /{' '}
        <code>AS_BUDGET_LOUD_USD</code> / <code>AS_BUDGET_HARD_USD</code> /{' '}
        <code>AS_BUDGET_NOTIFICATION_EMAIL</code> environment variables in{' '}
        <code>amplify/budgets.ts</code> and redeploys — that env-sync step is deferred to a
        follow-up. Live month-to-date spend display (Cost Explorer) is deferred to #303.
      </p>
    </div>
  );
}
