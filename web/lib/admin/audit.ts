'use client';

import { diffJson, type Change } from 'diff';
import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Admin audit-log data layer (#111).
 *
 * The AuditLog model is read-restricted to admin + moderator server-side
 * (`allow.groups(['moderator']).to(['read'])` + admin read), so every
 * call here resolves the `userPool` auth mode — the default guest/IAM
 * auth returns Unauthorized. Mirrors `web/lib/admin/linguistic.ts` and
 * the list+nextToken pagination idiom from `web/lib/uploads/query.ts`.
 *
 * Read-only by definition: the audit log is append-only and retained
 * forever, so this module exposes only `list` + pure helpers (filter
 * mapping, CSV serialization, JSON diff). No mutation surface.
 */

/** Action enum — kept in sync with `amplify/data/models/audit-log.ts`. */
export const AUDIT_ACTIONS = [
  'MESSAGE_DELETE',
  'MESSAGE_RESTORE',
  'MESSAGE_EDIT',
  'MESSAGE_SUBMIT_RECORDINGLESS',
  'RECORDING_DELETE',
  'RECORDING_RESTORE',
  'RECORDING_REPROCESS',
  'RECORDING_REPARSE',
  'COMMENT_DELETE',
  'USER_BAN',
  'USER_UNBAN',
  'USER_ROLE_CHANGE',
  'USER_PII_BLANK',
  'USER_CLAIM',
  'USER_CLAIM_FANOUT',
  'SDR_PII_BLANK',
  'FIELDVOTE_ORPHAN_SWEEP',
  'TRANSMITTER_CREATE',
  'TRANSMITTER_UPDATE',
  'TRANSMITTER_DELETE',
  'CALLSIGN_MERGE',
  'LINGUISTIC_CONFIG_UPDATE',
  'BAN_REGION_PAGE_UPDATE',
  'PROMPT_VERSION_BUMP',
  'BUDGET_THRESHOLD_UPDATE',
  'REP_FORMULA_UPDATE',
  'OTHER',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** A single AuditLog row, normalized for the viewer. */
export interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetMessageId: string | null;
  diff: unknown;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  claimId: string | null;
  createdAt: string | null;
}

/** Viewer filter state — all fields optional / "any". */
export interface AuditFilter {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  /** ISO date (inclusive lower bound on `createdAt`). */
  dateFrom?: string;
  /** ISO date (inclusive upper bound on `createdAt`). */
  dateTo?: string;
}

type RawRow = {
  id: string;
  actorId?: string | null;
  action?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetMessageId?: string | null;
  diff?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  claimId?: string | null;
  createdAt?: string | null;
};

type RawListResult = {
  data?: RawRow[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

export function toAuditRow(r: RawRow): AuditRow {
  return {
    id: r.id,
    actorId: r.actorId ?? null,
    action: r.action ?? 'OTHER',
    targetType: r.targetType ?? null,
    targetId: r.targetId ?? null,
    targetMessageId: r.targetMessageId ?? null,
    diff: r.diff ?? null,
    reason: r.reason ?? null,
    ipAddress: r.ipAddress ?? null,
    userAgent: r.userAgent ?? null,
    claimId: r.claimId ?? null,
    createdAt: r.createdAt ?? null,
  };
}

/**
 * Maps the viewer's filter state to an AppSync `filter` object. Returns
 * `undefined` when no filter is active (so `list` does a bare scan).
 *
 * `createdAt` range bounds use AppSync `ge` / `le` string comparison,
 * which works because Amplify stores timestamps as lexicographically
 * sortable ISO-8601. The day-granular `dateTo` is widened to the end of
 * that day (`T23:59:59.999Z`) so an inclusive upper bound captures the
 * whole selected day.
 */
export function buildAuditFilter(f: AuditFilter): Record<string, unknown> | undefined {
  const and: Record<string, unknown>[] = [];
  if (f.action) and.push({ action: { eq: f.action } });
  if (f.actorId?.trim()) and.push({ actorId: { eq: f.actorId.trim() } });
  if (f.targetType?.trim()) and.push({ targetType: { eq: f.targetType.trim() } });
  if (f.targetId?.trim()) and.push({ targetId: { eq: f.targetId.trim() } });
  if (f.dateFrom) and.push({ createdAt: { ge: normalizeFrom(f.dateFrom) } });
  if (f.dateTo) and.push({ createdAt: { le: normalizeTo(f.dateTo) } });
  if (and.length === 0) return undefined;
  if (and.length === 1) return and[0];
  return { and };
}

function normalizeFrom(d: string): string {
  // Bare `YYYY-MM-DD` → start of day UTC.
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d;
}

function normalizeTo(d: string): string {
  // Bare `YYYY-MM-DD` → end of day UTC (inclusive).
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59.999Z` : d;
}

export interface ListAuditResult {
  items: AuditRow[];
  nextToken: string | null;
}

export interface ListAuditOptions {
  pageSize?: number;
  nextToken?: string | null;
}

export async function listAudit(
  filter: AuditFilter = {},
  opts: ListAuditOptions = {},
): Promise<ListAuditResult> {
  const client = getDataClient();
  const listFn = client.models.AuditLog.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const args: Record<string, unknown> = {
    limit: opts.pageSize ?? 50,
    authMode,
  };
  const f = buildAuditFilter(filter);
  if (f) args.filter = f;
  if (opts.nextToken) args.nextToken = opts.nextToken;
  const raw = await listFn(args);
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  const rows = (raw.data ?? []).map(toAuditRow);
  // Newest first. AppSync list order is not guaranteed under a filter.
  rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { items: rows, nextToken: raw.nextToken ?? null };
}

/** Label for a (possibly system) actor. */
export function actorLabel(actorId: string | null): string {
  return actorId && actorId.trim() ? actorId : 'SYSTEM';
}

/* --------------------------------------------------------------------- *
 * CSV export (client-side blob)
 * --------------------------------------------------------------------- */

const CSV_COLUMNS = [
  'createdAt',
  'action',
  'actorId',
  'targetType',
  'targetId',
  'targetMessageId',
  'reason',
  'ipAddress',
  'userAgent',
  'claimId',
  'diff',
] as const;

/** RFC-4180 field escape: quote when the value holds `,`, `"`, or newline. */
export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function cellFor(row: AuditRow, col: (typeof CSV_COLUMNS)[number]): string {
  if (col === 'diff') {
    if (row.diff == null) return '';
    return typeof row.diff === 'string' ? row.diff : JSON.stringify(row.diff);
  }
  const v = row[col];
  if (v == null) return col === 'actorId' ? 'SYSTEM' : '';
  return String(v);
}

/** Serialize the loaded rows to a CSV string (header + one row each). */
export function toCsv(rows: readonly AuditRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((row) => CSV_COLUMNS.map((c) => csvEscape(cellFor(row, c))).join(','));
  return [header, ...lines].join('\r\n');
}

/* --------------------------------------------------------------------- *
 * JSON diff helper
 * --------------------------------------------------------------------- */

export type DiffSegment = { type: 'added' | 'removed' | 'unchanged'; value: string };

/**
 * Pure line-oriented JSON diff between two values (the `before` / `after`
 * payloads carried on an AuditLog `diff` column, or any pair). Returns an
 * ordered list of segments the viewer renders as a unified diff. Built on
 * the `diff` package's `diffJson` so it canonicalizes key order before
 * comparing.
 */
export function jsonDiff(before: unknown, after: unknown): DiffSegment[] {
  const a = before ?? {};
  const b = after ?? {};
  const parts: Change[] = diffJson(a, b);
  return parts.map((p) => ({
    type: p.added ? 'added' : p.removed ? 'removed' : 'unchanged',
    value: p.value,
  }));
}

/**
 * Extracts `{ before, after }` from an AuditLog `diff` payload. The
 * pipeline writes diffs in a couple of shapes (`{before,after}` is the
 * common one; some emit `{prev,next}`). Falls back to treating the whole
 * payload as the `after` side when no recognizable pair is present.
 */
export function splitDiffPayload(diff: unknown): { before: unknown; after: unknown } {
  if (diff && typeof diff === 'object') {
    const o = diff as Record<string, unknown>;
    if ('before' in o || 'after' in o) {
      return { before: o.before ?? null, after: o.after ?? null };
    }
    if ('prev' in o || 'next' in o) {
      return { before: o.prev ?? null, after: o.next ?? null };
    }
  }
  return { before: null, after: diff ?? null };
}
