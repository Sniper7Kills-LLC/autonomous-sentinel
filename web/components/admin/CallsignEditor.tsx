'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  listCallsigns,
  createCallsign,
  updateCallsign,
  approveCallsign,
  deleteCallsign,
  validateCallsignInput,
  rowToFormValues,
  EMPTY_FORM_VALUES,
  type CallsignRow,
  type CallsignFormValues,
  type CallsignFieldErrors,
  type CallsignSource,
} from '@/lib/admin/callsigns';
import styles from './CallsignEditor.module.css';

/**
 * Admin callsign-dictionary editor (#109).
 *
 * Two tabs over the admin-only `Callsign` model:
 *   - **Dictionary** — table of every callsign plus a create / edit /
 *     delete flow.
 *   - **Merge queue** — filtered to AI-suggested or unapproved rows, with
 *     per-row Approve (set `approved=true`) / Reject (delete) actions.
 *
 * Create/update/delete is gated to the `admin` Cognito group server-side;
 * this component renders behind `<AdminGate>` so moderators see the
 * admin-required notice instead of the editor. Validation runs
 * client-side via `validateCallsignInput` (the server is authoritative);
 * the list refetches after every successful mutation.
 *
 * DEFERRED — generating the AI dedup *suggestions* (the Bedrock pass that
 * scans the dictionary, auto-merges above a confidence threshold, and
 * queues lower-confidence merges as `source='AI_SUGGESTED'`) is OUT OF
 * SCOPE here; it needs a Bedrock Lambda (see #172 / #173). This editor is
 * the human CRUD plus the merge-queue *review* surface; those suggested
 * rows are plain model data an admin approves or rejects.
 */

type Mode = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; id: string };
type Tab = 'dictionary' | 'queue';

const SOURCE_OPTIONS: CallsignSource[] = ['ADMIN', 'LEGACY', 'AI_SUGGESTED'];

/** A row belongs in the merge queue when it is AI-suggested OR not yet approved. */
export function isQueued(row: CallsignRow): boolean {
  return row.source === 'AI_SUGGESTED' || !row.approved;
}

export function CallsignEditor() {
  const [rows, setRows] = useState<CallsignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('dictionary');
  const [mode, setMode] = useState<Mode>({ kind: 'closed' });
  const [form, setForm] = useState<CallsignFormValues>(EMPTY_FORM_VALUES);
  const [fieldErrors, setFieldErrors] = useState<CallsignFieldErrors>({});
  const [saving, setSaving] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listCallsigns());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load callsigns.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const queueRows = useMemo(() => rows.filter(isQueued), [rows]);

  const openCreate = useCallback(() => {
    setForm(EMPTY_FORM_VALUES);
    setFieldErrors({});
    setMode({ kind: 'create' });
  }, []);

  const openEdit = useCallback((row: CallsignRow) => {
    setForm(rowToFormValues(row));
    setFieldErrors({});
    setMode({ kind: 'edit', id: row.id });
  }, []);

  const closeForm = useCallback(() => {
    setMode({ kind: 'closed' });
    setFieldErrors({});
  }, []);

  const setField = useCallback(
    <K extends keyof CallsignFormValues>(key: K, value: CallsignFormValues[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const handleSubmit = useCallback(async () => {
    const { errors, input } = validateCallsignInput(form);
    setFieldErrors(errors);
    if (!input || mode.kind === 'closed') return;
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === 'create') {
        await createCallsign(input);
      } else {
        await updateCallsign(mode.id, input);
      }
      closeForm();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the callsign.');
    } finally {
      setSaving(false);
    }
  }, [form, mode, closeForm, reload]);

  const handleApprove = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await approveCallsign(id);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to approve the callsign.');
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await deleteCallsign(id);
        setConfirmDeleteId(null);
        if (mode.kind === 'edit' && mode.id === id) closeForm();
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete the callsign.');
      } finally {
        setBusyId(null);
      }
    },
    [mode, closeForm, reload],
  );

  const switchTab = useCallback(
    (next: Tab) => {
      setTab(next);
      setConfirmDeleteId(null);
      if (next === 'queue') closeForm();
    },
    [closeForm],
  );

  return (
    <section className={styles.editor} aria-labelledby="cs-editor-heading">
      <h2 id="cs-editor-heading" className={styles.formTitle}>
        Callsign dictionary
      </h2>

      <div className={styles.tabs} role="tablist" aria-label="Callsign views">
        <button
          type="button"
          role="tab"
          id="cs-tab-dictionary"
          aria-selected={tab === 'dictionary'}
          aria-controls="cs-panel-dictionary"
          className={`${styles.tab} ${tab === 'dictionary' ? styles.tabActive : ''}`}
          onClick={() => switchTab('dictionary')}
        >
          Dictionary ({rows.length})
        </button>
        <button
          type="button"
          role="tab"
          id="cs-tab-queue"
          aria-selected={tab === 'queue'}
          aria-controls="cs-panel-queue"
          className={`${styles.tab} ${tab === 'queue' ? styles.tabActive : ''}`}
          onClick={() => switchTab('queue')}
        >
          Merge queue ({queueRows.length})
        </button>
      </div>

      {tab === 'dictionary' ? (
        <div id="cs-panel-dictionary" role="tabpanel" aria-labelledby="cs-tab-dictionary">
          <div className={styles.toolbar}>
            <Button size="sm" onClick={openCreate} disabled={mode.kind === 'create'}>
              + New callsign
            </Button>
            <span className={styles.count} aria-live="polite">
              {rows.length} on file
            </span>
          </div>

          {mode.kind !== 'closed' && (
            <form
              className={styles.form}
              aria-label={mode.kind === 'create' ? 'Create callsign' : 'Edit callsign'}
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmit();
              }}
            >
              <p className={styles.formTitle}>
                {mode.kind === 'create' ? 'New callsign' : 'Edit callsign'}
              </p>
              <div className={styles.grid}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="cs-normalized">
                    Normalized *
                  </label>
                  <input
                    id="cs-normalized"
                    className={styles.input}
                    value={form.normalized}
                    onChange={(e) => setField('normalized', e.target.value)}
                    aria-invalid={fieldErrors.normalized ? true : undefined}
                    placeholder="SKYKING"
                  />
                  <span className={styles.hint}>Uppercased + trimmed on save.</span>
                  {fieldErrors.normalized && (
                    <span className={styles.fieldError} role="alert">
                      {fieldErrors.normalized}
                    </span>
                  )}
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="cs-source">
                    Source
                  </label>
                  <select
                    id="cs-source"
                    className={styles.input}
                    value={form.source}
                    onChange={(e) => setField('source', e.target.value as CallsignSource)}
                  >
                    {SOURCE_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="cs-variants">
                    Variants
                  </label>
                  <input
                    id="cs-variants"
                    className={styles.input}
                    value={form.variants}
                    onChange={(e) => setField('variants', e.target.value)}
                    placeholder="SKY KING, SKYKING"
                  />
                  <span className={styles.hint}>
                    Comma or space separated; deduped + uppercased.
                  </span>
                </div>

                <div className={styles.field}>
                  <span className={styles.label}>Approved</span>
                  <span className={styles.checkboxRow}>
                    <input
                      id="cs-approved"
                      type="checkbox"
                      checked={form.approved}
                      onChange={(e) => setField('approved', e.target.checked)}
                    />
                    <label htmlFor="cs-approved" className={styles.hint}>
                      Visible in the dictionary (unapproved rows queue for review).
                    </label>
                  </span>
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="cs-notes">
                  Notes
                </label>
                <textarea
                  id="cs-notes"
                  className={styles.textarea}
                  value={form.notes}
                  onChange={(e) => setField('notes', e.target.value)}
                />
              </div>

              <div className={styles.formActions}>
                <Button type="submit" loading={saving}>
                  {mode.kind === 'create' ? 'Create' : 'Save changes'}
                </Button>
                <Button type="button" variant="secondary" onClick={closeForm} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {loading ? (
            <p className={styles.muted} role="status">
              Loading callsigns…
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="cs-table">
                <thead>
                  <tr>
                    <th scope="col">Normalized</th>
                    <th scope="col">Variants</th>
                    <th scope="col">Source</th>
                    <th scope="col">Approved</th>
                    <th scope="col">Notes</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td className={styles.empty} colSpan={6}>
                        No callsigns yet. Create the first one.
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.normalized}</td>
                        <td>{row.variants.length ? row.variants.join(', ') : '—'}</td>
                        <td>
                          <span className={styles.sourceBadge}>{row.source ?? '—'}</span>
                        </td>
                        <td>{row.approved ? 'Yes' : 'No'}</td>
                        <td>{row.notes ?? '—'}</td>
                        <td>
                          {confirmDeleteId === row.id ? (
                            <span className={styles.confirm}>
                              <span className={styles.muted}>Delete?</span>
                              <Button
                                variant="danger"
                                size="sm"
                                loading={busyId === row.id}
                                onClick={() => void handleDelete(row.id)}
                              >
                                Confirm
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === row.id}
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                Cancel
                              </Button>
                            </span>
                          ) : (
                            <span className={styles.rowActions}>
                              <Button variant="secondary" size="sm" onClick={() => openEdit(row)}>
                                Edit
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                onClick={() => setConfirmDeleteId(row.id)}
                              >
                                Delete
                              </Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div id="cs-panel-queue" role="tabpanel" aria-labelledby="cs-tab-queue">
          <p className={styles.muted}>
            AI-suggested and unapproved entries awaiting review. Approve adds the entry to the
            dictionary; Reject deletes it.
          </p>
          {loading ? (
            <p className={styles.muted} role="status">
              Loading merge queue…
            </p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="cs-queue-table">
                <thead>
                  <tr>
                    <th scope="col">Normalized</th>
                    <th scope="col">Variants</th>
                    <th scope="col">Source</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queueRows.length === 0 ? (
                    <tr>
                      <td className={styles.empty} colSpan={5}>
                        Merge queue is empty. AI-suggested entries appear here once the dedup pass
                        runs.
                      </td>
                    </tr>
                  ) : (
                    queueRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.normalized}</td>
                        <td>{row.variants.length ? row.variants.join(', ') : '—'}</td>
                        <td>
                          <span className={styles.sourceBadge}>{row.source ?? '—'}</span>
                        </td>
                        <td>{row.confidence == null ? '—' : row.confidence.toFixed(2)}</td>
                        <td>
                          <span className={styles.rowActions}>
                            <Button
                              variant="primary"
                              size="sm"
                              loading={busyId === row.id}
                              onClick={() => void handleApprove(row.id)}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              loading={busyId === row.id}
                              onClick={() => void handleDelete(row.id)}
                            >
                              Reject
                            </Button>
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}

      <p className={styles.deferNote}>
        AI dedup suggestion generation (the Bedrock pass that auto-merges above a confidence
        threshold and queues lower-confidence merges) is deferred to the migration / Bedrock work
        (#172, #173). This editor is the human dictionary CRUD plus the merge-queue review surface.
      </p>
    </section>
  );
}
