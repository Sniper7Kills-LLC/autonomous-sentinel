'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  listAudit,
  toCsv,
  jsonDiff,
  splitDiffPayload,
  actorLabel,
  AUDIT_ACTIONS,
  type AuditRow,
  type AuditFilter,
  type DiffSegment,
} from '@/lib/admin/audit';
import styles from './AuditLogViewer.module.css';

/**
 * Admin audit-log viewer (#111).
 *
 * Read-only, filterable table of every AuditLog entry. No mutation
 * affordances exist — the log is append-only and retained forever. Data
 * loads via the generated `client.models.AuditLog.list` (admin/mod read
 * server-side); `Load more` pages through the AppSync `nextToken`. Each
 * row expands to a unified JSON diff of its `before` / `after` payload.
 * The currently-loaded rows export to CSV client-side.
 */
const PAGE_SIZE = 50;

export function AuditLogViewer() {
  const [draft, setDraft] = useState<AuditFilter>({});
  const [applied, setApplied] = useState<AuditFilter>({});
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (filter: AuditFilter, token: string | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAudit(filter, { pageSize: PAGE_SIZE, nextToken: token });
      // Sort the COMBINED set newest-first. Each page is sorted
      // independently server-side, but concatenating two independently
      // sorted pages does not yield a globally sorted list — if page 2's
      // newest row predates page 1's oldest, order breaks across the
      // boundary. Re-sort the merged array so both the table and the CSV
      // export (which reads this same `rows` state) stay globally
      // newest-first.
      setRows((prev) =>
        (append ? [...prev, ...res.items] : res.items)
          .slice()
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
      );
      setNextToken(res.nextToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the audit log.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load({}, null, false);
  }, [load]);

  const applyFilters = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setExpanded(null);
      setApplied(draft);
      void load(draft, null, false);
    },
    [draft, load],
  );

  const resetFilters = useCallback(() => {
    setDraft({});
    setApplied({});
    setExpanded(null);
    void load({}, null, false);
  }, [load]);

  const loadMore = useCallback(() => {
    if (nextToken) void load(applied, nextToken, true);
  }, [applied, nextToken, load]);

  const exportCsv = useCallback(() => {
    const csv = toCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [rows]);

  const set = <K extends keyof AuditFilter>(key: K, value: string) =>
    setDraft((prev) => ({ ...prev, [key]: value || undefined }));

  return (
    <section className={styles.page} aria-labelledby="audit-heading">
      <h2 id="audit-heading" className={styles.srOnly}>
        Audit log entries
      </h2>

      <form className={styles.filters} onSubmit={applyFilters} aria-label="Audit log filters">
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Action</span>
          <select
            className={styles.input}
            value={draft.action ?? ''}
            onChange={(e) => set('action', e.target.value)}
          >
            <option value="">Any action</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Actor ID</span>
          <input
            className={styles.input}
            type="text"
            value={draft.actorId ?? ''}
            placeholder="Cognito sub"
            onChange={(e) => set('actorId', e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Target type</span>
          <input
            className={styles.input}
            type="text"
            value={draft.targetType ?? ''}
            placeholder="Message, User…"
            onChange={(e) => set('targetType', e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Target ID</span>
          <input
            className={styles.input}
            type="text"
            value={draft.targetId ?? ''}
            onChange={(e) => set('targetId', e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>From</span>
          <input
            className={styles.input}
            type="date"
            value={draft.dateFrom ?? ''}
            onChange={(e) => set('dateFrom', e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>To</span>
          <input
            className={styles.input}
            type="date"
            value={draft.dateTo ?? ''}
            onChange={(e) => set('dateTo', e.target.value)}
          />
        </label>

        <div className={styles.filterActions}>
          <Button type="submit" size="sm" disabled={loading}>
            Apply filters
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={resetFilters} disabled={loading}>
            Reset
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={exportCsv}
            disabled={rows.length === 0}
          >
            Export CSV
          </Button>
        </div>
      </form>

      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}

      <div className={styles.tableWrap} role="region" aria-label="Audit entries" tabIndex={0}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Timestamp (UTC)</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Target</th>
              <th scope="col">Reason</th>
              <th scope="col">Diff</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={6} className={styles.empty}>
                  No audit entries match.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isOpen = expanded === r.id;
                const sys = r.actorId == null || r.actorId.trim() === '';
                return (
                  <AuditRowView
                    key={r.id}
                    row={r}
                    isOpen={isOpen}
                    isSystem={sys}
                    onToggle={() => setExpanded(isOpen ? null : r.id)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.footer}>
        {loading && (
          <span className={styles.muted} role="status">
            Loading…
          </span>
        )}
        <span className={styles.muted}>{rows.length} loaded</span>
        {nextToken && (
          <Button type="button" variant="secondary" size="sm" onClick={loadMore} disabled={loading}>
            Load more
          </Button>
        )}
      </div>
    </section>
  );
}

function AuditRowView({
  row,
  isOpen,
  isSystem,
  onToggle,
}: {
  row: AuditRow;
  isOpen: boolean;
  isSystem: boolean;
  onToggle: () => void;
}) {
  const { before, after } = splitDiffPayload(row.diff);
  const segments: DiffSegment[] = isOpen ? jsonDiff(before, after) : [];
  return (
    <>
      <tr className={styles.row}>
        <td className={styles.mono}>{row.createdAt ?? '—'}</td>
        <td>
          <span className={styles.tag}>{row.action}</span>
        </td>
        <td className={styles.mono}>
          {isSystem ? <span className={styles.systemTag}>SYSTEM</span> : actorLabel(row.actorId)}
        </td>
        <td className={styles.mono}>
          {row.targetType ?? '—'}
          {row.targetId ? <span className={styles.muted}> · {row.targetId}</span> : null}
        </td>
        <td>{row.reason ?? '—'}</td>
        <td>
          <button
            type="button"
            className={styles.diffToggle}
            aria-expanded={isOpen}
            onClick={onToggle}
          >
            {isOpen ? 'Hide diff' : 'View diff'}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={6} className={styles.diffCell}>
            <pre className={styles.diff} aria-label="Before / after diff">
              {segments.map((s, i) => (
                <span
                  key={i}
                  className={
                    s.type === 'added'
                      ? styles.diffAdd
                      : s.type === 'removed'
                        ? styles.diffDel
                        : styles.diffSame
                  }
                >
                  {s.value}
                </span>
              ))}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
