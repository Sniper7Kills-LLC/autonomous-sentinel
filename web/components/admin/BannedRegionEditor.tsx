'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { MarkdownPreview } from '@/components/admin/MarkdownPreview';
import {
  listBannedRegionPages,
  createBannedRegionPage,
  updateBannedRegionPage,
  deleteBannedRegionPage,
  validateBannedRegionInput,
  rowToFormValues,
  EMPTY_FORM_VALUES,
  type BannedRegionRow,
  type BannedRegionFormValues,
  type BannedRegionFieldErrors,
} from '@/lib/admin/banned-regions';
import styles from './BannedRegionEditor.module.css';

/**
 * Admin banned-region landing-page editor (#113).
 *
 * Table of per-country markdown pages plus a create / edit / delete flow
 * over the admin-only `BannedRegionPage` model. The model's primary key
 * IS the `countryCode`, so the country code is read-only when editing an
 * existing row (changing it would create a different page).
 *
 * Create/update/delete is gated to the `admin` Cognito group server-side;
 * this component renders behind `<AdminGate>` so moderators (who can
 * reach the `(admin)` group) see the admin-required notice instead.
 *
 * XSS note: the markdown body is operator-authored but the issue calls
 * out spammer injection. The live preview routes through
 * `<MarkdownPreview>`, which tokenizes markdown and maps every token to a
 * React element — no `dangerouslySetInnerHTML`, so raw `<script>` /
 * `<iframe>` / event handlers in the source render as inert text rather
 * than executing. There is no raw-HTML sink anywhere in this path.
 *
 * Public serving of the rendered page to blocked visitors is DEFERRED to
 * #202 (infra / WAF custom-response). This is the admin EDITOR only.
 */

type Mode = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; countryCode: string };

export function BannedRegionEditor() {
  const [rows, setRows] = useState<BannedRegionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>({ kind: 'closed' });
  const [form, setForm] = useState<BannedRegionFormValues>(EMPTY_FORM_VALUES);
  const [fieldErrors, setFieldErrors] = useState<BannedRegionFieldErrors>({});
  const [saving, setSaving] = useState(false);

  const [confirmDeleteCode, setConfirmDeleteCode] = useState<string | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listBannedRegionPages());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load banned-region pages.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = useCallback(() => {
    setForm(EMPTY_FORM_VALUES);
    setFieldErrors({});
    setMode({ kind: 'create' });
  }, []);

  const openEdit = useCallback((row: BannedRegionRow) => {
    setForm(rowToFormValues(row));
    setFieldErrors({});
    setMode({ kind: 'edit', countryCode: row.countryCode });
  }, []);

  const closeForm = useCallback(() => {
    setMode({ kind: 'closed' });
    setFieldErrors({});
  }, []);

  const setField = useCallback(
    <K extends keyof BannedRegionFormValues>(key: K, value: BannedRegionFormValues[K]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const handleSubmit = useCallback(async () => {
    const { errors, input } = validateBannedRegionInput(form);
    setFieldErrors(errors);
    if (!input || mode.kind === 'closed') return;
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === 'create') {
        await createBannedRegionPage(input);
      } else {
        // countryCode is the PK and read-only when editing; carry the
        // original through so the update keys off the existing row.
        await updateBannedRegionPage({ ...input, countryCode: mode.countryCode });
      }
      closeForm();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the page.');
    } finally {
      setSaving(false);
    }
  }, [form, mode, closeForm, reload]);

  const handleDelete = useCallback(
    async (countryCode: string) => {
      setBusyCode(countryCode);
      setError(null);
      try {
        await deleteBannedRegionPage(countryCode);
        setConfirmDeleteCode(null);
        if (mode.kind === 'edit' && mode.countryCode === countryCode) closeForm();
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete the page.');
      } finally {
        setBusyCode(null);
      }
    },
    [mode, closeForm, reload],
  );

  return (
    <section className={styles.editor} aria-labelledby="br-editor-heading">
      <div className={styles.toolbar}>
        <h2 id="br-editor-heading" className={styles.formTitle}>
          Banned-region pages
        </h2>
        <Button size="sm" onClick={openCreate} disabled={mode.kind === 'create'}>
          + New page
        </Button>
        <span className={styles.count} aria-live="polite">
          {rows.length} on file
        </span>
      </div>

      {mode.kind !== 'closed' && (
        <form
          className={styles.form}
          aria-label={
            mode.kind === 'create' ? 'Create banned-region page' : 'Edit banned-region page'
          }
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <p className={styles.formTitle}>
            {mode.kind === 'create' ? 'New page' : `Edit page · ${mode.countryCode}`}
          </p>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="br-country">
                Country code *
              </label>
              <input
                id="br-country"
                className={styles.input}
                value={form.countryCode}
                maxLength={2}
                readOnly={mode.kind === 'edit'}
                onChange={(e) => setField('countryCode', e.target.value.toUpperCase())}
                aria-invalid={fieldErrors.countryCode ? true : undefined}
                placeholder="US"
              />
              <span className={styles.hint}>ISO-3166-1 alpha-2 (two letters).</span>
              {fieldErrors.countryCode && (
                <span className={styles.fieldError} role="alert">
                  {fieldErrors.countryCode}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="br-title">
                Title *
              </label>
              <input
                id="br-title"
                className={styles.input}
                value={form.title}
                onChange={(e) => setField('title', e.target.value)}
                aria-invalid={fieldErrors.title ? true : undefined}
              />
              {fieldErrors.title && (
                <span className={styles.fieldError} role="alert">
                  {fieldErrors.title}
                </span>
              )}
            </div>

            <div className={`${styles.field} ${styles.checkboxField}`}>
              <input
                id="br-enabled"
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setField('enabled', e.target.checked)}
              />
              <label className={styles.label} htmlFor="br-enabled">
                Enabled
              </label>
            </div>
          </div>

          <div className={styles.editorSplit}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="br-body">
                Body markdown *
              </label>
              <textarea
                id="br-body"
                className={styles.textarea}
                value={form.bodyMarkdown}
                onChange={(e) => setField('bodyMarkdown', e.target.value)}
                aria-invalid={fieldErrors.bodyMarkdown ? true : undefined}
              />
              <span className={styles.hint}>
                Markdown only. Raw HTML (script / iframe / handlers) is rendered as inert text.
              </span>
              {fieldErrors.bodyMarkdown && (
                <span className={styles.fieldError} role="alert">
                  {fieldErrors.bodyMarkdown}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <p className={styles.previewLabel} id="br-preview-label">
                Live preview
              </p>
              <div className={styles.previewPane} aria-labelledby="br-preview-label">
                <MarkdownPreview source={form.bodyMarkdown} />
              </div>
            </div>
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
          Loading banned-region pages…
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="br-table">
            <thead>
              <tr>
                <th scope="col">Country</th>
                <th scope="col">Title</th>
                <th scope="col">Enabled</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className={styles.empty} colSpan={4}>
                    No banned-region pages yet. Create the first one.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.countryCode}>
                    <td>{row.countryCode}</td>
                    <td>{row.title}</td>
                    <td>
                      <Badge tone={row.enabled ? 'success' : 'neutral'}>
                        {row.enabled ? 'enabled' : 'disabled'}
                      </Badge>
                    </td>
                    <td>
                      {confirmDeleteCode === row.countryCode ? (
                        <span className={styles.confirm}>
                          <span className={styles.muted}>Delete?</span>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={busyCode === row.countryCode}
                            onClick={() => void handleDelete(row.countryCode)}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyCode === row.countryCode}
                            onClick={() => setConfirmDeleteCode(null)}
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
                            onClick={() => setConfirmDeleteCode(row.countryCode)}
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

      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}

      <p className={styles.deferNote}>
        Public serving of these pages to blocked visitors is handled by #202 (WAF custom-response).
        This editor only authors the per-country content.
      </p>
    </section>
  );
}
