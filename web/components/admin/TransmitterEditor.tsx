'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/Button';
import {
  listTransmitters,
  createTransmitter,
  updateTransmitter,
  deleteTransmitter,
  validateTransmitterInput,
  rowToFormValues,
  EMPTY_FORM_VALUES,
  type TransmitterRow,
  type TransmitterFormValues,
  type TransmitterFieldErrors,
} from '@/lib/admin/transmitters';
import styles from './TransmitterEditor.module.css';

// LocationPicker uses maplibre-gl (browser + WebGL only) — dynamic import required
// for the static-export Next.js build (output:'export') and SSR safety.
const LocationPicker = dynamic(
  () => import('@/components/map/LocationPicker').then((m) => m.LocationPicker),
  { ssr: false, loading: () => <div className={styles.mapPlaceholder}>Loading map…</div> },
);

/**
 * Admin transmitter editor (#108).
 *
 * Table of known EAM broadcast sites plus a create / edit / delete flow
 * over the admin-only `Transmitter` model. Create/update/delete is
 * gated to the `admin` Cognito group server-side; this component is
 * rendered behind `<AdminGate>` so moderators (who can reach the
 * `(admin)` group) see the admin-required notice instead of the editor.
 *
 * The form is fully validated client-side via
 * `validateTransmitterInput` (the server is authoritative regardless);
 * the list refetches after every successful mutation.
 *
 * Lat/lon map preview + click-to-set picker is DEFERRED to #83 — the
 * propagation-map work owns the `maplibre-gl` dependency. Until then,
 * coordinates are entered through plain numeric inputs.
 */

type Mode = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; id: string };

export function TransmitterEditor() {
  const [rows, setRows] = useState<TransmitterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>({ kind: 'closed' });
  const [form, setForm] = useState<TransmitterFormValues>(EMPTY_FORM_VALUES);
  const [fieldErrors, setFieldErrors] = useState<TransmitterFieldErrors>({});
  const [saving, setSaving] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listTransmitters());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transmitters.');
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

  const openEdit = useCallback((row: TransmitterRow) => {
    setForm(rowToFormValues(row));
    setFieldErrors({});
    setMode({ kind: 'edit', id: row.id });
  }, []);

  const closeForm = useCallback(() => {
    setMode({ kind: 'closed' });
    setFieldErrors({});
  }, []);

  const setField = useCallback(
    (key: keyof TransmitterFormValues, value: string) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const handleSubmit = useCallback(async () => {
    const { errors, input } = validateTransmitterInput(form);
    setFieldErrors(errors);
    if (!input || mode.kind === 'closed') return;
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === 'create') {
        await createTransmitter(input);
      } else {
        await updateTransmitter(mode.id, input);
      }
      closeForm();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the transmitter.');
    } finally {
      setSaving(false);
    }
  }, [form, mode, closeForm, reload]);

  const handleDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await deleteTransmitter(id);
        setConfirmDeleteId(null);
        if (mode.kind === 'edit' && mode.id === id) closeForm();
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete the transmitter.');
      } finally {
        setBusyId(null);
      }
    },
    [mode, closeForm, reload],
  );

  return (
    <section className={styles.editor} aria-labelledby="tx-editor-heading">
      <div className={styles.toolbar}>
        <h2 id="tx-editor-heading" className={styles.formTitle}>
          Transmitters
        </h2>
        <Button size="sm" onClick={openCreate} disabled={mode.kind === 'create'}>
          + New transmitter
        </Button>
        <span className={styles.count} aria-live="polite">
          {rows.length} on file
        </span>
      </div>

      {mode.kind !== 'closed' && (
        <form
          className={styles.form}
          aria-label={mode.kind === 'create' ? 'Create transmitter' : 'Edit transmitter'}
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <p className={styles.formTitle}>
            {mode.kind === 'create' ? 'New transmitter' : 'Edit transmitter'}
          </p>
          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="tx-name">
                Name *
              </label>
              <input
                id="tx-name"
                className={styles.input}
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                aria-invalid={fieldErrors.name ? true : undefined}
              />
              {fieldErrors.name && (
                <span className={styles.fieldError} role="alert">
                  {fieldErrors.name}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="tx-callsign">
                Callsign
              </label>
              <input
                id="tx-callsign"
                className={styles.input}
                value={form.callsign}
                onChange={(e) => setField('callsign', e.target.value)}
              />
            </div>

            <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
              <span className={styles.label}>Location * (click or drag the marker)</span>
              <LocationPicker
                latitude={form.latitude ? parseFloat(form.latitude) : null}
                longitude={form.longitude ? parseFloat(form.longitude) : null}
                onChange={(lat, lng) => {
                  setField('latitude', String(lat));
                  setField('longitude', String(lng));
                }}
              />
              <div className={styles.coordFallbacks}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="tx-lat">
                    Latitude *
                  </label>
                  <input
                    id="tx-lat"
                    className={styles.input}
                    inputMode="decimal"
                    value={form.latitude}
                    onChange={(e) => setField('latitude', e.target.value)}
                    aria-invalid={fieldErrors.latitude ? true : undefined}
                  />
                  {fieldErrors.latitude && (
                    <span className={styles.fieldError} role="alert">
                      {fieldErrors.latitude}
                    </span>
                  )}
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="tx-lon">
                    Longitude *
                  </label>
                  <input
                    id="tx-lon"
                    className={styles.input}
                    inputMode="decimal"
                    value={form.longitude}
                    onChange={(e) => setField('longitude', e.target.value)}
                    aria-invalid={fieldErrors.longitude ? true : undefined}
                  />
                  {fieldErrors.longitude && (
                    <span className={styles.fieldError} role="alert">
                      {fieldErrors.longitude}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="tx-freqs">
                Frequencies (kHz)
              </label>
              <input
                id="tx-freqs"
                className={styles.input}
                value={form.frequencyKhzList}
                onChange={(e) => setField('frequencyKhzList', e.target.value)}
                aria-invalid={fieldErrors.frequencyKhzList ? true : undefined}
                placeholder="8992, 11175, 6739"
              />
              <span className={styles.hint}>Comma or space separated whole numbers.</span>
              {fieldErrors.frequencyKhzList && (
                <span className={styles.fieldError} role="alert">
                  {fieldErrors.frequencyKhzList}
                </span>
              )}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="tx-notes">
              Notes
            </label>
            <textarea
              id="tx-notes"
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
          Loading transmitters…
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="tx-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Callsign</th>
                <th scope="col">Lat / Lon</th>
                <th scope="col">Frequencies (kHz)</th>
                <th scope="col">Notes</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className={styles.empty} colSpan={6}>
                    No transmitters yet. Create the first one.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>{row.callsign ?? '—'}</td>
                    <td>
                      {row.latitude ?? '—'}, {row.longitude ?? '—'}
                    </td>
                    <td>{row.frequencyKhzList.length ? row.frequencyKhzList.join(', ') : '—'}</td>
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

      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}

    </section>
  );
}
