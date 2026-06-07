'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/Button';
import {
  listMySdrs,
  createOwnedSdr,
  submitPublicSdr as submitPublicSdrFn,
  validateOwnedSdrInput,
  validatePublicSdrInput,
  EMPTY_OWNED_FORM,
  EMPTY_PUBLIC_FORM,
  type SdrRow,
  type OwnedSdrFormValues,
  type PublicSdrFormValues,
  type OwnedSdrFieldErrors,
  type PublicSdrFieldErrors,
} from '@/lib/sdr';
import styles from './SdrSettingsPanel.module.css';

/**
 * Member SDR registration and public SDR submission panel (#785).
 *
 * Two tabs:
 *   - "My SDRs" — list the caller's SDRs (kind + reviewStatus badges)
 *   - "Register Owned SDR" — create an OWNED SDR with map picker
 *   - "Submit Public SDR" — submit a PUBLIC SDR (KiwiSDR/WebSDR) for admin review
 *
 * Uses the LocationPicker dynamically (browser-only, MapLibre).
 */

// Dynamic import: LocationPicker uses maplibre-gl (browser + WebGL only)
const LocationPicker = dynamic(
  () => import('@/components/map/LocationPicker').then((m) => m.LocationPicker),
  { ssr: false, loading: () => <div className={styles.mapPlaceholder}>Loading map…</div> },
);

type ActiveTab = 'list' | 'add-owned' | 'add-public';

const REVIEW_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const REVIEW_STATUS_TONES: Record<string, string> = {
  PENDING: styles.badgePending ?? '',
  APPROVED: styles.badgeApproved ?? '',
  REJECTED: styles.badgeRejected ?? '',
};

export function SdrSettingsPanel() {
  const [tab, setTab] = useState<ActiveTab>('list');
  const [sdrs, setSdrs] = useState<SdrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // Owned SDR form
  const [ownedForm, setOwnedForm] = useState<OwnedSdrFormValues>(EMPTY_OWNED_FORM);
  const [ownedErrors, setOwnedErrors] = useState<OwnedSdrFieldErrors>({});
  const [ownedSaving, setOwnedSaving] = useState(false);
  const [ownedSuccess, setOwnedSuccess] = useState(false);
  const [ownedError, setOwnedError] = useState<string | null>(null);

  // Public SDR form
  const [publicForm, setPublicForm] = useState<PublicSdrFormValues>(EMPTY_PUBLIC_FORM);
  const [publicErrors, setPublicErrors] = useState<PublicSdrFieldErrors>({});
  const [publicSaving, setPublicSaving] = useState(false);
  const [publicSuccess, setPublicSuccess] = useState(false);
  const [publicError, setPublicError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setSdrs(await listMySdrs());
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Failed to load SDRs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleOwnedLocationChange = useCallback((lat: number, lng: number) => {
    setOwnedForm((prev) => ({
      ...prev,
      latitude: String(lat),
      longitude: String(lng),
    }));
  }, []);

  const handlePublicLocationChange = useCallback((lat: number, lng: number) => {
    setPublicForm((prev) => ({
      ...prev,
      latitude: String(lat),
      longitude: String(lng),
    }));
  }, []);

  const handleOwnedSubmit = useCallback(async () => {
    const { errors, input } = validateOwnedSdrInput(ownedForm);
    setOwnedErrors(errors);
    if (!input) return;
    setOwnedSaving(true);
    setOwnedError(null);
    setOwnedSuccess(false);
    try {
      await createOwnedSdr(input);
      setOwnedForm(EMPTY_OWNED_FORM);
      setOwnedErrors({});
      setOwnedSuccess(true);
      await reload();
      setTab('list');
    } catch (e) {
      setOwnedError(e instanceof Error ? e.message : 'Failed to register SDR.');
    } finally {
      setOwnedSaving(false);
    }
  }, [ownedForm, reload]);

  const handlePublicSubmit = useCallback(async () => {
    const { errors, input } = validatePublicSdrInput(publicForm);
    setPublicErrors(errors);
    if (!input) return;
    setPublicSaving(true);
    setPublicError(null);
    setPublicSuccess(false);
    try {
      await submitPublicSdrFn(input);
      setPublicForm(EMPTY_PUBLIC_FORM);
      setPublicErrors({});
      setPublicSuccess(true);
      await reload();
      setTab('list');
    } catch (e) {
      setPublicError(e instanceof Error ? e.message : 'Failed to submit SDR.');
    } finally {
      setPublicSaving(false);
    }
  }, [publicForm, reload]);

  return (
    <div className={styles.panel}>
      <nav className={styles.tabs} role="tablist" aria-label="SDR registration tabs">
        <button
          role="tab"
          aria-selected={tab === 'list'}
          className={`${styles.tab} ${tab === 'list' ? styles.tabActive : ''}`}
          onClick={() => setTab('list')}
        >
          My SDRs ({sdrs.length})
        </button>
        <button
          role="tab"
          aria-selected={tab === 'add-owned'}
          className={`${styles.tab} ${tab === 'add-owned' ? styles.tabActive : ''}`}
          onClick={() => setTab('add-owned')}
        >
          Register Owned SDR
        </button>
        <button
          role="tab"
          aria-selected={tab === 'add-public'}
          className={`${styles.tab} ${tab === 'add-public' ? styles.tabActive : ''}`}
          onClick={() => setTab('add-public')}
        >
          Submit Public SDR
        </button>
      </nav>

      {tab === 'list' && (
        <section className={styles.listSection} aria-labelledby="sdr-list-heading">
          <h2 id="sdr-list-heading" className={styles.sectionTitle}>
            Your SDRs
          </h2>
          {loading ? (
            <p className={styles.muted} role="status">
              Loading…
            </p>
          ) : listError ? (
            <p className={styles.error} role="alert">
              {listError}
            </p>
          ) : sdrs.length === 0 ? (
            <p className={styles.muted}>
              No SDRs yet. Register your own receiver or submit a public one above.
            </p>
          ) : (
            <ul className={styles.sdrList}>
              {sdrs.map((sdr) => (
                <li key={sdr.id} className={styles.sdrItem}>
                  <div className={styles.sdrName}>{sdr.name}</div>
                  <div className={styles.sdrMeta}>
                    <span className={styles.badge}>
                      {sdr.kind === 'PUBLIC' ? 'Public SDR' : 'Owned SDR'}
                    </span>
                    {sdr.kind === 'OWNED' && (
                      <span className={styles.badge}>
                        {sdr.publicVisible ? 'Visible on map' : 'Hidden from map'}
                      </span>
                    )}
                    {sdr.kind === 'PUBLIC' && sdr.reviewStatus && (
                      <span
                        className={`${styles.badge} ${REVIEW_STATUS_TONES[sdr.reviewStatus] ?? ''}`}
                      >
                        {REVIEW_STATUS_LABELS[sdr.reviewStatus] ?? sdr.reviewStatus}
                      </span>
                    )}
                    {sdr.url && (
                      <a
                        href={sdr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.urlLink}
                      >
                        {sdr.url}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'add-owned' && (
        <section className={styles.formSection} aria-labelledby="owned-form-heading">
          <h2 id="owned-form-heading" className={styles.sectionTitle}>
            Register an Owned SDR
          </h2>
          <p className={styles.formDesc}>
            Register a software-defined radio you operate and use to feed recordings to this site.
            You control map visibility with the public toggle.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleOwnedSubmit();
            }}
            className={styles.form}
            aria-label="Register owned SDR"
          >
            <div className={styles.field}>
              <label className={styles.label} htmlFor="owned-name">
                Name *
              </label>
              <input
                id="owned-name"
                className={styles.input}
                value={ownedForm.name}
                onChange={(e) => setOwnedForm((p) => ({ ...p, name: e.target.value }))}
                aria-invalid={ownedErrors.name ? true : undefined}
                placeholder="e.g. Home rooftop SDR"
              />
              {ownedErrors.name && (
                <span className={styles.fieldError} role="alert">
                  {ownedErrors.name}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Location (optional)</span>
              <LocationPicker
                latitude={ownedForm.latitude ? parseFloat(ownedForm.latitude) : null}
                longitude={ownedForm.longitude ? parseFloat(ownedForm.longitude) : null}
                onChange={handleOwnedLocationChange}
                label="Click the map to set your SDR's location"
              />
              {ownedErrors.latitude && (
                <span className={styles.fieldError} role="alert">
                  {ownedErrors.latitude}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="owned-granularity">
                Location precision
              </label>
              <select
                id="owned-granularity"
                className={styles.input}
                value={ownedForm.locationGranularity}
                onChange={(e) =>
                  setOwnedForm((p) => ({
                    ...p,
                    locationGranularity: e.target.value as OwnedSdrFormValues['locationGranularity'],
                  }))
                }
              >
                <option value="">— not set —</option>
                <option value="EXACT">Exact (show full coordinates)</option>
                <option value="CITY">City (~11 km blur)</option>
                <option value="REGION">Region (~111 km blur)</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={ownedForm.publicVisible}
                  onChange={(e) =>
                    setOwnedForm((p) => ({ ...p, publicVisible: e.target.checked }))
                  }
                />
                Show on public propagation map
              </label>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="owned-notes">
                Notes (optional)
              </label>
              <textarea
                id="owned-notes"
                className={styles.textarea}
                value={ownedForm.notes}
                onChange={(e) => setOwnedForm((p) => ({ ...p, notes: e.target.value }))}
                rows={3}
              />
            </div>

            {ownedError && (
              <p className={styles.error} role="alert">
                {ownedError}
              </p>
            )}
            {ownedSuccess && (
              <p className={styles.success} role="status">
                SDR registered successfully.
              </p>
            )}

            <div className={styles.formActions}>
              <Button type="submit" loading={ownedSaving}>
                Register SDR
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setTab('list')}
                disabled={ownedSaving}
              >
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}

      {tab === 'add-public' && (
        <section className={styles.formSection} aria-labelledby="public-form-heading">
          <h2 id="public-form-heading" className={styles.sectionTitle}>
            Submit a Public SDR
          </h2>
          <p className={styles.formDesc}>
            Submit a public third-party receiver (e.g. KiwiSDR, WebSDR, University of Twente) for
            inclusion on the map. Your submission will be reviewed by an admin before it appears
            publicly.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handlePublicSubmit();
            }}
            className={styles.form}
            aria-label="Submit public SDR"
          >
            <div className={styles.field}>
              <label className={styles.label} htmlFor="public-name">
                Name *
              </label>
              <input
                id="public-name"
                className={styles.input}
                value={publicForm.name}
                onChange={(e) => setPublicForm((p) => ({ ...p, name: e.target.value }))}
                aria-invalid={publicErrors.name ? true : undefined}
                placeholder="e.g. KiwiSDR Tokyo"
              />
              {publicErrors.name && (
                <span className={styles.fieldError} role="alert">
                  {publicErrors.name}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="public-url">
                Stream URL *
              </label>
              <input
                id="public-url"
                className={styles.input}
                type="url"
                value={publicForm.url}
                onChange={(e) => setPublicForm((p) => ({ ...p, url: e.target.value }))}
                aria-invalid={publicErrors.url ? true : undefined}
                placeholder="http://rx.example.com:8073"
              />
              {publicErrors.url && (
                <span className={styles.fieldError} role="alert">
                  {publicErrors.url}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Location (optional)</span>
              <LocationPicker
                latitude={publicForm.latitude ? parseFloat(publicForm.latitude) : null}
                longitude={publicForm.longitude ? parseFloat(publicForm.longitude) : null}
                onChange={handlePublicLocationChange}
                label="Click the map to set the receiver's location"
              />
              {publicErrors.latitude && (
                <span className={styles.fieldError} role="alert">
                  {publicErrors.latitude}
                </span>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="public-granularity">
                Location precision
              </label>
              <select
                id="public-granularity"
                className={styles.input}
                value={publicForm.locationGranularity}
                onChange={(e) =>
                  setPublicForm((p) => ({
                    ...p,
                    locationGranularity: e.target.value as PublicSdrFormValues['locationGranularity'],
                  }))
                }
              >
                <option value="">— not set —</option>
                <option value="EXACT">Exact</option>
                <option value="CITY">City (~11 km)</option>
                <option value="REGION">Region (~111 km)</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="public-notes">
                Notes (optional)
              </label>
              <textarea
                id="public-notes"
                className={styles.textarea}
                value={publicForm.notes}
                onChange={(e) => setPublicForm((p) => ({ ...p, notes: e.target.value }))}
                rows={3}
                placeholder="Any helpful context about this receiver…"
              />
            </div>

            {publicError && (
              <p className={styles.error} role="alert">
                {publicError}
              </p>
            )}
            {publicSuccess && (
              <p className={styles.success} role="status">
                SDR submitted for review. An admin will review it shortly.
              </p>
            )}

            <div className={styles.formActions}>
              <Button type="submit" loading={publicSaving}>
                Submit for review
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setTab('list')}
                disabled={publicSaving}
              >
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
