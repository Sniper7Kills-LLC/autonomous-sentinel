import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for Comment custom mutations (#32).
 *
 * Two dispatch cases:
 *
 *   - `createComment` — server-side depth clamp + flatten. The
 *     client provides `messageId`, `body`, and optionally
 *     `parentCommentId`. The handler:
 *       - Validates the parent exists + is on the same Message
 *         (cross-message replies are a forgery vector).
 *       - Computes `depth = min(parent.depth + 1, 3)`.
 *       - When the parent is already at depth 3, the new comment
 *         keeps `parentCommentId` pointing at the depth-3 parent
 *         (attaches as a sibling within the depth-3 layer — the
 *         "flatten" behaviour from CLAUDE.md).
 *       - Sets `authorId = ctx.identity.sub`; never trusts the
 *         client-supplied value.
 *
 *   - `softDeleteComment` — author OR mod/admin. Sets `deletedAt`,
 *     rewrites `body` to `[removed]` (so existing threads stay
 *     structurally intact but the offending text is gone), emits
 *     `COMMENT_DELETE` AuditLog. Idempotent on already-deleted
 *     rows.
 *
 * Schema-level grant for the Lambda's IAM role lives in
 * `data/resource.ts` under `allow.resource(commentMutations)`.
 *
 * Orphan-comment risk: `createComment` does not GetItem on Message
 * to confirm `messageId` references an existing row. Top-level
 * comments + parent-supplied comments both can land on a fake
 * messageId (parent-supplied path only checks parent-messageId
 * consistency, not Message existence). Orphans are inert — every
 * consumer query joins on Message, so a row with no parent never
 * surfaces — and the per-create GetItem would double the hot-path
 * cost. Cleanup tracked at #290 (mirrors the FieldVote orphan
 * janitor pattern from #270 / #281).
 *
 * Deferred (out of scope, tracked elsewhere):
 *   - Auto-flag hook from the hybrid wordlist + Comprehend pipeline
 *     (phase 9 #167). Flipping `flagged=true` on new bodies is a
 *     post-create side effect that the create resolver does not
 *     currently call.
 *   - Orphan-comment janitor (#290).
 */

export type CommentRow = {
  id: string;
  messageId: string;
  parentCommentId?: string | null;
  depth: number;
  body: string;
  authorId: string;
  flagged?: boolean | null;
  deletedAt?: string | null;
  [k: string]: unknown;
};

export interface CommentMutationsDataClient {
  models: {
    Comment: {
      get: (input: { id: string }) => Promise<{
        data: CommentRow | null;
        errors?: unknown;
      }>;
      create: (input: Omit<CommentRow, 'id'>) => Promise<{
        data: CommentRow | null;
        errors?: unknown;
      }>;
      update: (
        input: Partial<CommentRow> & { id: string },
      ) => Promise<{ data: CommentRow | null; errors?: unknown }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

interface Deps {
  dataClient?: CommentMutationsDataClient;
  audit?: AuditFn;
  now?: () => Date;
}

let injected: Deps = {};

export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedDefaultClient: CommentMutationsDataClient | undefined;

async function getDefaultClient(): Promise<CommentMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as CommentMutationsDataClient;
  return cachedDefaultClient;
}

const MAX_DEPTH = 3;

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function identityGroups(identity: unknown): readonly string[] {
  if (!identity || typeof identity !== 'object') return [];
  const groups = (identity as { groups?: unknown }).groups;
  return Array.isArray(groups) ? (groups as readonly string[]) : [];
}

function auditContextFrom(event: {
  identity?: unknown;
  request?: { headers?: Record<string, string | undefined> };
}): AuditContext {
  const sub = identitySub(event.identity);
  return {
    identity: sub ? { sub } : null,
    request: { headers: event.request?.headers ?? {} },
  };
}

function snapshot(row: CommentRow): Record<string, unknown> {
  return { ...row };
}

async function dispatchCreate(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, CommentRow | null>>[0],
  deps: { client: CommentMutationsDataClient; now: () => Date },
): Promise<CommentRow | null> {
  const authorSub = identitySub(event.identity);
  if (!authorSub) {
    throw new Error('createComment: caller has no identity sub');
  }
  const args = event.arguments;
  const messageId = typeof args.messageId === 'string' ? args.messageId : '';
  const body = typeof args.body === 'string' ? args.body : '';
  const parentArg = typeof args.parentCommentId === 'string' ? args.parentCommentId : null;
  if (!messageId) {
    throw new Error('createComment: messageId argument is required');
  }
  if (!body) {
    throw new Error('createComment: body argument is required');
  }

  let depth = 0;
  const parentCommentId: string | undefined = parentArg ?? undefined;

  if (parentCommentId) {
    const parentFetch = await deps.client.models.Comment.get({ id: parentCommentId });
    const parent = parentFetch.data;
    if (!parent) {
      throw new Error(`createComment: parentCommentId ${parentCommentId} not found`);
    }
    if (parent.messageId !== messageId) {
      throw new Error(
        `createComment: parent comment belongs to message ${parent.messageId}, not ${messageId}`,
      );
    }
    // Depth-clamp + flatten. If parent is already at MAX_DEPTH, the
    // new comment keeps the parent's id as its parent (attaches as a
    // sibling in the deepest layer) and stays at MAX_DEPTH itself.
    depth = Math.min(parent.depth + 1, MAX_DEPTH);
  }

  const created = await deps.client.models.Comment.create({
    messageId,
    parentCommentId,
    depth,
    body,
    authorId: authorSub,
    flagged: false,
    deletedAt: null,
  });
  if (created.errors) {
    throw new Error(
      `createComment: Comment.create returned errors: ${JSON.stringify(created.errors)}`,
    );
  }
  return created.data;
}

async function dispatchSoftDelete(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, CommentRow | null>>[0],
  deps: { client: CommentMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<CommentRow | null> {
  const callerSub = identitySub(event.identity);
  if (!callerSub) {
    throw new Error('softDeleteComment: caller has no identity sub');
  }
  const args = event.arguments;
  const targetId = typeof args.commentId === 'string' ? args.commentId : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!targetId) {
    throw new Error('softDeleteComment: commentId argument is required');
  }

  const fetched = await deps.client.models.Comment.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`softDeleteComment: Comment row not found for id=${targetId}`);
  }
  if (before.deletedAt) {
    return before;
  }

  const groups = identityGroups(event.identity);
  const isMod = groups.indexOf('moderator') >= 0 || groups.indexOf('admin') >= 0;
  const isAuthor = before.authorId === callerSub;
  if (!isAuthor && !isMod) {
    throw new Error('softDeleteComment: caller lacks permission (not author, mod, or admin)');
  }

  const now = deps.now().toISOString();
  const normalisedReason: string | null = reason ? reason : null;
  const patch: Partial<CommentRow> & { id: string } = {
    id: targetId,
    deletedAt: now,
    body: '[removed]',
  };
  const updated = await deps.client.models.Comment.update(patch);
  if (updated.errors) {
    throw new Error(
      `softDeleteComment: Comment.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  await deps.audit(auditContextFrom(event), {
    action: 'COMMENT_DELETE',
    targetType: 'Comment',
    targetId,
    before: snapshot(before),
    after: snapshot(after),
    reason: normalisedReason,
  });

  return after;
}

export const handler: AppSyncResolverHandler<Record<string, unknown>, CommentRow | null> = async (
  event,
) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());

  const field = event.info.fieldName;
  switch (field) {
    case 'createComment':
      return dispatchCreate(event, { client, now });
    case 'softDeleteComment':
      return dispatchSoftDelete(event, { client, audit: auditFn, now });
    default:
      throw new Error(`commentMutations: unsupported fieldName "${field}"`);
  }
};
