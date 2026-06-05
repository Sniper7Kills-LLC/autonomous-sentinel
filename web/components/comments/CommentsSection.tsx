'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { AbuseReportButton } from '@/components/abuse/AbuseReportButton';
import { UserNameLink } from '@/components/users/UserNameLink';
import { useSessionState } from '@/components/account/SessionGreeting';
import { isModeratorOrAdmin } from '@/lib/auth/roles';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import {
  buildCommentTree,
  countComments,
  editOwnComment,
  listComments,
  setCommentHidden,
  softDeleteComment,
  submitComment,
  type CommentNode,
  type DisplayComment,
  MAX_DISPLAY_DEPTH,
} from '@/lib/comments/query';
import styles from './CommentsSection.module.css';

/** Client-side edit window — mirrors the issue's 5-minute lock. */
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

interface CommentsSectionProps {
  messageId: string;
}

function isWithinEditWindow(createdAt: string | null, now: number): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t <= EDIT_WINDOW_MS;
}

function formatTs(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

function wasEdited(c: DisplayComment): boolean {
  if (!c.createdAt || !c.updatedAt) return false;
  return new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;
}

/**
 * `<CommentsSection>` — community discussion thread for a Message (#98).
 *
 * - Lists comments via `listComments` and renders them nested up to 3
 *   levels (top + 2 reply tiers); deeper replies flatten into the
 *   deepest tier (handled by `buildCommentTree`).
 * - Top-level composer + per-comment inline reply composer (the reply
 *   button still works at max depth — the server/tree flattens it into
 *   the deepest tier).
 * - Own comments get edit (within a 5-minute window) + delete; mods and
 *   admins get a hide toggle (flips the `flagged` flag). Flag affordance
 *   reuses `<AbuseReportButton targetType="COMMENT">` (#99).
 * - Signed-out visitors read the thread; the composer prompts sign-in.
 * - Hidden (flagged) + soft-deleted comments keep their thread slot via
 *   a placeholder so nesting structure survives.
 */
export function CommentsSection({ messageId }: CommentsSectionProps) {
  const session = useSessionState();
  const [comments, setComments] = useState<DisplayComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { groups } = useCallerGroups();
  const isMod = isModeratorOrAdmin(groups);
  const [composerBody, setComposerBody] = useState('');
  const [posting, setPosting] = useState(false);

  const reload = useCallback(async () => {
    const list = await listComments(messageId);
    setComments(list);
  }, [messageId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listComments(messageId)
      .then((list) => {
        if (!cancelled) setComments(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const tree = buildCommentTree(comments);
  const total = countComments(tree);

  const postTopLevel = useCallback(async () => {
    const body = composerBody.trim();
    if (!body) return;
    setPosting(true);
    setError(null);
    try {
      await submitComment(messageId, body, null);
      setComposerBody('');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }, [composerBody, messageId, reload]);

  return (
    <section className={styles.section} aria-labelledby="comments-title">
      <div className={styles.header}>
        <h3 id="comments-title" className={styles.heading}>
          Discussion
        </h3>
        <span className={styles.count}>
          {total} comment{total === 1 ? '' : 's'}
        </span>
      </div>

      {session.signedIn ? (
        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            void postTopLevel();
          }}
        >
          <label htmlFor="comment-composer" className="sr-only">
            Add a comment
          </label>
          <textarea
            id="comment-composer"
            className={styles.textarea}
            rows={3}
            maxLength={2000}
            value={composerBody}
            onChange={(e) => setComposerBody(e.target.value)}
            placeholder="Add to the discussion…"
          />
          <div className={styles.composerActions}>
            <Button
              type="submit"
              size="sm"
              loading={posting}
              disabled={posting || composerBody.trim().length === 0}
            >
              Post comment
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.signInPrompt}>Sign in to join the discussion.</p>
      )}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className={styles.empty} aria-busy>
          Loading comments…
        </p>
      ) : total === 0 ? (
        <p className={styles.empty}>Be the first to comment.</p>
      ) : (
        <div className={styles.thread}>
          {tree.map((node) => (
            <CommentItem
              key={node.id}
              node={node}
              messageId={messageId}
              callerSub={session.sub}
              signedIn={session.signedIn}
              isMod={isMod}
              onChanged={() => void reload().catch(() => undefined)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface CommentItemProps {
  node: CommentNode;
  messageId: string;
  callerSub: string | null;
  signedIn: boolean;
  isMod: boolean;
  onChanged: () => void;
}

function CommentItem({ node, messageId, callerSub, signedIn, isMod, onChanged }: CommentItemProps) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(node.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwn = callerSub != null && node.authorId === callerSub;
  const isDeleted = node.deletedAt != null;
  const isHidden = node.flagged && !isOwn && !isMod;
  // Snapshot "now" once at mount via a lazy state initializer rather than
  // calling Date.now() during render — render must stay pure for React
  // Compiler (react-hooks/purity). The edit window is minutes-long, so a
  // mount-time snapshot is sufficient for gating the edit affordance.
  const [now] = useState(() => Date.now());
  const canEdit = isOwn && !isDeleted && isWithinEditWindow(node.createdAt, now);

  const doReply = useCallback(async () => {
    const body = replyBody.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      // Pass the displayed node's id as parent — the backend clamps
      // depth + re-parents when this node is already at the deepest
      // tier (flatten), so the reply lands as a sibling at tier 3.
      await submitComment(messageId, body, node.id);
      setReplyBody('');
      setReplyOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [messageId, node.id, onChanged, replyBody]);

  const doEdit = useCallback(async () => {
    const body = editBody.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await editOwnComment(node.id, body);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [editBody, node.id, onChanged]);

  const doDelete = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await softDeleteComment(node.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [node.id, onChanged]);

  const doToggleHide = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await setCommentHidden(node.id, !node.flagged);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [node.flagged, node.id, onChanged]);

  return (
    <article className={styles.item} data-testid={`comment-${node.id}`}>
      <div className={styles.meta}>
        {isDeleted ? (
          <span className={styles.author}>—</span>
        ) : (
          <UserNameLink sub={node.authorId} className={styles.author} />
        )}
        <span>{formatTs(node.createdAt)}</span>
        {!isDeleted && wasEdited(node) && (
          <span className={styles.edited} aria-label="edited">
            (edited)
          </span>
        )}
        <span className={styles.spacer} />
        {node.flagged && (isMod || isOwn) && (
          <span className={styles.flagBadge} title="Flagged / hidden for review">
            Hidden
          </span>
        )}
      </div>

      {isDeleted ? (
        <p className={styles.placeholder}>[comment deleted]</p>
      ) : isHidden ? (
        <p className={styles.placeholder}>Comment hidden by a moderator.</p>
      ) : editing ? (
        <form
          className={styles.replyComposer}
          onSubmit={(e) => {
            e.preventDefault();
            void doEdit();
          }}
        >
          <label htmlFor={`edit-${node.id}`} className="sr-only">
            Edit comment
          </label>
          <textarea
            id={`edit-${node.id}`}
            className={styles.textarea}
            rows={3}
            maxLength={2000}
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
          />
          <div className={styles.composerActions}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => {
                setEditing(false);
                setEditBody(node.body);
              }}
            >
              Cancel
            </button>
            <Button type="submit" size="sm" loading={busy} disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.body}>{node.body}</p>
      )}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {!isDeleted && !isHidden && !editing && (
        <div className={styles.actions}>
          {signedIn && (
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => setReplyOpen((o) => !o)}
              aria-expanded={replyOpen}
            >
              Reply
            </button>
          )}
          {callerSub && (
            <AbuseReportButton
              targetType="COMMENT"
              targetId={node.id}
              reporterId={callerSub}
              label="Flag"
            />
          )}
          {canEdit && (
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => {
                setEditBody(node.body);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          {isOwn && (
            <button
              type="button"
              className={styles.actionBtn}
              disabled={busy}
              onClick={() => void doDelete()}
            >
              Delete
            </button>
          )}
          {isMod && (
            <button
              type="button"
              className={styles.actionBtn}
              disabled={busy}
              onClick={() => void doToggleHide()}
            >
              {node.flagged ? 'Unhide' : 'Hide'}
            </button>
          )}
        </div>
      )}

      {replyOpen && signedIn && (
        <form
          className={styles.replyComposer}
          onSubmit={(e) => {
            e.preventDefault();
            void doReply();
          }}
        >
          <label htmlFor={`reply-${node.id}`} className="sr-only">
            Reply to comment
          </label>
          <textarea
            id={`reply-${node.id}`}
            className={styles.textarea}
            rows={2}
            maxLength={2000}
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder={
              node.displayDepth >= MAX_DISPLAY_DEPTH
                ? 'Reply (added to this thread at the deepest level)…'
                : 'Write a reply…'
            }
          />
          <div className={styles.composerActions}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => {
                setReplyOpen(false);
                setReplyBody('');
              }}
            >
              Cancel
            </button>
            <Button type="submit" size="sm" loading={busy} disabled={busy}>
              Post reply
            </Button>
          </div>
        </form>
      )}

      {node.children.length > 0 && (
        <div className={styles.children}>
          {node.children.map((child) => (
            <CommentItem
              key={child.id}
              node={child}
              messageId={messageId}
              callerSub={callerSub}
              signedIn={signedIn}
              isMod={isMod}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </article>
  );
}
