'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Comment thread data access + tree builder (#98).
 *
 * Backend surface (see `amplify/data/models/comment.ts`):
 *   - `Comment` model — `list` (guest + authenticated read). Fields:
 *     `id`, `messageId`, `parentCommentId`, `depth`, `body`,
 *     `authorId`, `flagged`, `deletedAt`, `createdAt`, `updatedAt`.
 *   - `submitComment` custom mutation — depth-clamp + flatten +
 *     server-forced `authorId`. The sole create path.
 *   - `softDeleteComment` custom mutation — author/mod/admin soft
 *     delete (sets `deletedAt`, rewrites body to `[removed]`, audits).
 *
 * Edit (own) + hide (mod/admin) ride the model's `update` grant
 * (`allow.ownerDefinedIn('authorId')...['update']` and
 * `allow.groups(['moderator','admin'])...['update']`) via
 * `Comment.update`. The server enforces authz; the client UI only
 * decides what to render.
 *
 * The display tree is capped at 3 levels (top + 2 reply tiers) per
 * CLAUDE.md. The backend already clamps stored `depth` to 3 and
 * re-parents flatten cases onto the deepest legal ancestor, so a
 * faithful parent→child walk naturally produces a ≤3-deep tree. The
 * builder defensively re-clamps so a malformed row can never blow the
 * nesting past tier 3.
 */

/** Max display depth: top-level (0) + two reply tiers (1, 2). */
export const MAX_DISPLAY_DEPTH = 2;

export interface DisplayComment {
  id: string;
  messageId: string;
  parentCommentId: string | null;
  /** Server-stored depth (1-based-ish: backend clamps to 3). */
  depth: number;
  body: string;
  authorId: string;
  flagged: boolean;
  deletedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CommentNode extends DisplayComment {
  /** Zero-based display depth after clamp (0 = top, max 2). */
  displayDepth: number;
  children: CommentNode[];
}

type RawComment = {
  id: string;
  messageId: string;
  parentCommentId?: string | null;
  depth?: number | null;
  body?: string | null;
  authorId?: string | null;
  flagged?: boolean | null;
  deletedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type RawListResult = {
  data?: RawComment[] | null;
  errors?: { message: string }[] | null;
};

type RawSingleResult = {
  data?: RawComment | null;
  errors?: { message: string }[] | null;
};

export function toDisplayComment(r: RawComment): DisplayComment {
  return {
    id: r.id,
    messageId: r.messageId,
    parentCommentId: r.parentCommentId ?? null,
    depth: typeof r.depth === 'number' ? r.depth : 0,
    body: r.body ?? '',
    authorId: r.authorId ?? '',
    flagged: Boolean(r.flagged),
    deletedAt: r.deletedAt ?? null,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  };
}

function createdAtMs(c: DisplayComment): number {
  if (!c.createdAt) return 0;
  const t = new Date(c.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Build the nested comment tree, oldest-first at every tier, capped at
 * `MAX_DISPLAY_DEPTH + 1` levels (top + 2 reply tiers).
 *
 * Flatten rule: a reply whose parent is already at the deepest display
 * tier is rendered as a sibling within that deepest tier (it shares the
 * parent's display depth). This mirrors the backend depth-clamp — a
 * depth-3 stored row whose `parentCommentId` points at another depth-3
 * row is attached alongside, never indented further.
 *
 * Orphans (parentCommentId points at a missing row) are promoted to
 * top-level so they remain visible.
 */
export function buildCommentTree(comments: DisplayComment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const c of comments) {
    byId.set(c.id, { ...c, displayDepth: 0, children: [] });
  }

  const roots: CommentNode[] = [];
  // Stable insertion order = oldest first so children attach predictably.
  const ordered = [...comments].sort((a, b) => createdAtMs(a) - createdAtMs(b));

  for (const c of ordered) {
    const node = byId.get(c.id);
    if (!node) continue;
    const parent = c.parentCommentId ? byId.get(c.parentCommentId) : undefined;
    if (!parent) {
      node.displayDepth = 0;
      roots.push(node);
      continue;
    }
    if (parent.displayDepth >= MAX_DISPLAY_DEPTH) {
      // Flatten: a reply to a deepest-tier comment becomes a sibling of
      // that comment within the deepest tier (it shares the parent's
      // display depth and joins the parent's own container), never
      // indenting past tier 2.
      node.displayDepth = parent.displayDepth;
      const container = parent.parentCommentId ? byId.get(parent.parentCommentId) : undefined;
      if (container) {
        container.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      node.displayDepth = parent.displayDepth + 1;
      parent.children.push(node);
    }
  }

  // Sort every tier oldest-first for deterministic render order.
  const sortTier = (nodes: CommentNode[]): void => {
    nodes.sort((a, b) => createdAtMs(a) - createdAtMs(b));
    for (const n of nodes) sortTier(n.children);
  };
  sortTier(roots);

  return roots;
}

/** Total node count (including all nested tiers) — for empty-state. */
export function countComments(nodes: CommentNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1 + countComments(node.children);
  }
  return n;
}

export async function listComments(messageId: string): Promise<DisplayComment[]> {
  const client = getDataClient();
  const listFn = client.models.Comment.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const raw = await listFn({
    filter: { messageId: { eq: messageId } },
    authMode,
  });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  return (raw.data ?? []).map(toDisplayComment);
}

export async function submitComment(
  messageId: string,
  body: string,
  parentCommentId?: string | null,
): Promise<DisplayComment> {
  const client = getDataClient();
  const submitFn = client.mutations.submitComment as unknown as (
    input: { messageId: string; body: string; parentCommentId?: string | null },
    opts: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await submitFn(
    { messageId, body, parentCommentId: parentCommentId ?? null },
    { authMode: 'userPool' },
  );
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) throw new Error('submitComment: empty response');
  return toDisplayComment(raw.data);
}

export async function editOwnComment(commentId: string, body: string): Promise<DisplayComment> {
  const client = getDataClient();
  const updateFn = client.models.Comment.update as unknown as (
    input: { id: string; body: string },
    opts: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await updateFn({ id: commentId, body }, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) throw new Error('editOwnComment: empty response');
  return toDisplayComment(raw.data);
}

export async function softDeleteComment(commentId: string): Promise<DisplayComment> {
  const client = getDataClient();
  const delFn = client.mutations.softDeleteComment as unknown as (
    input: { commentId: string },
    opts: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await delFn({ commentId }, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) throw new Error('softDeleteComment: empty response');
  return toDisplayComment(raw.data);
}

/**
 * Moderator/admin hide — rides the model `update` grant to flip
 * `flagged = true`. Hidden (flagged) comments keep their thread slot
 * but render a "hidden by a moderator" placeholder to non-mod viewers.
 * The server enforces the group authz; the UI gates the affordance.
 */
export async function setCommentHidden(
  commentId: string,
  hidden: boolean,
): Promise<DisplayComment> {
  const client = getDataClient();
  const updateFn = client.models.Comment.update as unknown as (
    input: { id: string; flagged: boolean },
    opts: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await updateFn({ id: commentId, flagged: hidden }, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) throw new Error('setCommentHidden: empty response');
  return toDisplayComment(raw.data);
}
