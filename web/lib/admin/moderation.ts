'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { setCommentHidden } from '@/lib/comments/query';

/**
 * Admin / moderator unified moderation queue data-access layer (#118).
 *
 * Aggregates flagged + reported content from the sources that exist on
 * the backend today into one `QueueItem[]`:
 *   - `AbuseReport` rows in an open state (status OPEN / REVIEWING) — the
 *     user-report surface. Mods + admins hold `update`, so "mark
 *     resolved" / "mark dismissed" ride `AbuseReport.update`.
 *   - `Comment` rows with `flagged = true` — auto-flag / hidden surface.
 *     Hide / unhide reuse `setCommentHidden` (rides `Comment.update`).
 *   - `Message` rows with `flaggedForReview = true` — recording-less +
 *     low-confidence surface. Mods + admins hold `Message.update`, so
 *     "clear flag" rides `Message.update`.
 *
 * Deferred — no server-grantable path exists yet, so they are NOT wired:
 *   - `TranscriptRevision` flag surface: the model carries no flag field
 *     (it tracks `accepted` / `superseded` / `voteScore` only), so there
 *     is nothing to aggregate. Tracked under #34 / #287.
 *   - Soft-delete content from the queue: `softDeleteComment` /
 *     `softDeleteMessage` exist but are owned by their own surfaces; the
 *     queue links out to those rather than duplicating destructive flows.
 *   - Ban user: opened from #112's ban modal, not an action here.
 *   - Add-to-wordlist: no wordlist-override model exists yet (#93 / #95 /
 *     #98 own the pipeline + override store). Omitted, not faked.
 *
 * All reads use the `userPool` auth mode — AbuseReport read, the Comment
 * `flagged` filter and Message `flaggedForReview` filter are mod/admin
 * grants honoured only through the JWT group claim (see
 * `web/lib/auth/mode.ts`). Non-mods get Unauthorized from AppSync; this
 * layer only assembles data, the server enforces authorization.
 */

const USER_POOL = { authMode: 'userPool' as const };

/** The source models the queue aggregates. */
export type QueueSource = 'ABUSE_REPORT' | 'COMMENT' | 'MESSAGE';

export interface QueueItem {
  /** Stable, source-prefixed id so mixed rows never collide. */
  key: string;
  source: QueueSource;
  /** Underlying row id (used to wire actions). */
  targetId: string;
  /** Short human label for the source. */
  sourceLabel: string;
  /** One-line excerpt / summary of the offending content. */
  summary: string;
  /** Reporter cognito sub (abuse reports only). */
  reporter: string | null;
  /** Reason (abuse reports only). */
  reason: string | null;
  /** ISO timestamp the row was created, or null. */
  createdAt: string | null;
  /** In-app link to the underlying content, or null when none resolves. */
  href: string | null;
}

type RawAbuseReport = {
  id: string;
  reporterId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  notes?: string | null;
  status?: string | null;
  createdAt?: string | null;
};

type RawComment = {
  id: string;
  messageId?: string | null;
  body?: string | null;
  flagged?: boolean | null;
  deletedAt?: string | null;
  createdAt?: string | null;
};

type RawMessage = {
  id: string;
  sender?: string | null;
  receiver?: string | null;
  body?: string | null;
  type?: string | null;
  flaggedForReview?: boolean | null;
  deletedAt?: string | null;
  broadcastTs?: string | null;
  createdAt?: string | null;
};

type RawListResult<T> = {
  data?: T[] | null;
  errors?: { message: string }[] | null;
};

type RawMutResult<T> = {
  data?: T | null;
  errors?: { message: string }[] | null;
};

type ListFn<T> = (input?: Record<string, unknown>) => Promise<RawListResult<T>>;
type UpdateFn<T> = (
  input: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<RawMutResult<T>>;

function throwOnErrors(errors: { message: string }[] | null | undefined, op: string): void {
  if (errors && errors.length > 0) {
    throw new Error(`${op} failed: ${errors.map((e) => e.message).join('; ')}`);
  }
}

/** Collapse whitespace + clamp to a single-line excerpt. */
export function excerpt(text: string | null | undefined, max = 140): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length === 0) return '(empty)';
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Link to the message detail view (the only resolvable target today). */
function messageHref(messageId: string | null | undefined): string | null {
  return messageId ? `/messages/view?id=${encodeURIComponent(messageId)}` : null;
}

// --- pure normalizers (unit-tested) -----------------------------------

export function normalizeAbuseReport(r: RawAbuseReport): QueueItem {
  const target = r.targetType ?? 'CONTENT';
  return {
    key: `ABUSE_REPORT#${r.id}`,
    source: 'ABUSE_REPORT',
    targetId: r.id,
    sourceLabel: 'User report',
    summary: excerpt(r.notes) === '(empty)' ? `Report on ${target}` : excerpt(r.notes),
    reporter: r.reporterId ?? null,
    reason: r.reason ?? null,
    createdAt: r.createdAt ?? null,
    // Only MESSAGE targets resolve to an in-app route today.
    href: r.targetType === 'MESSAGE' ? messageHref(r.targetId) : null,
  };
}

export function normalizeComment(r: RawComment): QueueItem {
  return {
    key: `COMMENT#${r.id}`,
    source: 'COMMENT',
    targetId: r.id,
    sourceLabel: 'Flagged comment',
    summary: excerpt(r.body),
    reporter: null,
    reason: null,
    createdAt: r.createdAt ?? null,
    href: messageHref(r.messageId),
  };
}

export function normalizeMessage(r: RawMessage): QueueItem {
  const headline = [r.sender, r.receiver].filter(Boolean).join(' → ');
  const body = excerpt(r.body);
  return {
    key: `MESSAGE#${r.id}`,
    source: 'MESSAGE',
    targetId: r.id,
    sourceLabel: 'Flagged message',
    summary: headline ? `${headline}: ${body}` : body,
    reporter: null,
    reason: r.type ?? null,
    createdAt: r.createdAt ?? r.broadcastTs ?? null,
    href: messageHref(r.id),
  };
}

// --- sort + filter (unit-tested) --------------------------------------

function createdMs(item: QueueItem): number {
  if (!item.createdAt) return 0;
  const t = new Date(item.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Oldest-unreviewed-first ordering per the issue spec. */
export function sortQueueOldestFirst(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => createdMs(a) - createdMs(b));
}

export type SourceFilter = QueueSource | 'ALL';

export function filterBySource(items: QueueItem[], source: SourceFilter): QueueItem[] {
  if (source === 'ALL') return items;
  return items.filter((i) => i.source === source);
}

// --- AppSync aggregation queries --------------------------------------

function listFn<T>(name: string): ListFn<T> {
  const client = getDataClient();
  const model = (client.models as Record<string, unknown>)[name] as
    | { list?: ListFn<T> }
    | undefined;
  if (!model?.list) {
    throw new Error(`${name} model is not available on the data client.`);
  }
  return model.list.bind(model);
}

async function listOpenAbuseReports(): Promise<RawAbuseReport[]> {
  const list = listFn<RawAbuseReport>('AbuseReport');
  const res = await list({
    filter: { or: [{ status: { eq: 'OPEN' } }, { status: { eq: 'REVIEWING' } }] },
    ...USER_POOL,
  });
  throwOnErrors(res.errors, 'listOpenAbuseReports');
  return res.data ?? [];
}

async function listFlaggedComments(): Promise<RawComment[]> {
  const list = listFn<RawComment>('Comment');
  const res = await list({ filter: { flagged: { eq: true } }, ...USER_POOL });
  throwOnErrors(res.errors, 'listFlaggedComments');
  // Soft-deleted rows are already gone from the public surface; keep them
  // out of the active queue.
  return (res.data ?? []).filter((c) => !c.deletedAt);
}

async function listFlaggedMessages(): Promise<RawMessage[]> {
  const list = listFn<RawMessage>('Message');
  const res = await list({ filter: { flaggedForReview: { eq: true } }, ...USER_POOL });
  throwOnErrors(res.errors, 'listFlaggedMessages');
  return (res.data ?? []).filter((m) => !m.deletedAt);
}

/**
 * Fetch + normalize the full queue across every wired source, oldest
 * first. Sources are fetched in parallel; a failure in any one source
 * rejects the whole call so the UI can surface it.
 */
export async function listModerationQueue(): Promise<QueueItem[]> {
  const [reports, comments, messages] = await Promise.all([
    listOpenAbuseReports(),
    listFlaggedComments(),
    listFlaggedMessages(),
  ]);
  const items: QueueItem[] = [
    ...reports.map(normalizeAbuseReport),
    ...comments.map(normalizeComment),
    ...messages.map(normalizeMessage),
  ];
  return sortQueueOldestFirst(items);
}

// --- wired actions ----------------------------------------------------

/** Hide / unhide a flagged comment — reuses the comments wrapper. */
export async function setQueueCommentHidden(commentId: string, hidden: boolean): Promise<void> {
  await setCommentHidden(commentId, hidden);
}

/**
 * Clear a Message's review flag — rides the mod/admin `Message.update`
 * grant. Resolves the message off the queue.
 */
export async function clearMessageFlag(messageId: string): Promise<void> {
  const client = getDataClient();
  const update = client.models.Message.update as unknown as UpdateFn<RawMessage>;
  const res = await update({ id: messageId, flaggedForReview: false }, USER_POOL);
  throwOnErrors(res.errors, 'clearMessageFlag');
  if (!res.data) throw new Error('clearMessageFlag: empty response');
}

/**
 * Resolve / dismiss an AbuseReport — rides the mod/admin
 * `AbuseReport.update` grant. `status` flips to RESOLVED (default) or
 * DISMISSED.
 */
export async function resolveAbuseReport(
  reportId: string,
  status: 'RESOLVED' | 'DISMISSED' = 'RESOLVED',
): Promise<void> {
  const client = getDataClient();
  const update = client.models.AbuseReport.update as unknown as UpdateFn<RawAbuseReport>;
  const res = await update(
    { id: reportId, status, resolvedAt: new Date().toISOString() },
    USER_POOL,
  );
  throwOnErrors(res.errors, 'resolveAbuseReport');
  if (!res.data) throw new Error('resolveAbuseReport: empty response');
}
