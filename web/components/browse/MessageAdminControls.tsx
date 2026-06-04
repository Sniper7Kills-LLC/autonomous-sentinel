'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import { isAdmin, isModeratorOrAdmin } from '@/lib/auth/roles';
import { clearMessageFlag } from '@/lib/admin/moderation';
import { softDeleteMessage } from '@/lib/messages/admin';
import styles from './MessageDetailView.module.css';

interface MessageAdminControlsProps {
  messageId: string;
  /** Whether the Message currently carries the review flag. */
  flaggedForReview: boolean;
  /**
   * Called after a successful action so the parent can refresh: `flag`
   * clears the flag in place; `delete` should navigate away / show the
   * removed state.
   */
  onChanged: (action: 'flag' | 'delete') => void;
}

type Feedback = { tone: 'ok' | 'err'; text: string } | null;

/**
 * Moderator/admin-only inline moderation for a single Message (#721) —
 * lets a mod act on an entry without opening the admin panel:
 *   - "Clear review flag" (moderator + admin) when `flaggedForReview`.
 *   - "Delete message" (admin only) → `softDeleteMessage`, behind a
 *     confirm with an optional audit reason.
 *
 * Hidden entirely for members/guests; the gate mirrors
 * `RecordingAdminControls` (`useCallerGroups` → role check). The server
 * enforces its own authorization on each mutation — this only decides
 * what to render.
 */
export function MessageAdminControls({
  messageId,
  flaggedForReview,
  onChanged,
}: MessageAdminControlsProps) {
  const { groups } = useCallerGroups();
  const [busy, setBusy] = useState<null | 'flag' | 'delete'>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [reason, setReason] = useState('');
  // Guards against a state update after `onChanged('delete')` unmounts
  // this control (the parent swaps to the soft-deleted empty state).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!isModeratorOrAdmin(groups)) return null;

  const admin = isAdmin(groups);

  async function run(
    kind: 'flag' | 'delete',
    action: () => Promise<void>,
    okText: string,
  ): Promise<void> {
    setBusy(kind);
    setFeedback(null);
    try {
      await action();
      if (mounted.current) setFeedback({ tone: 'ok', text: okText });
      onChanged(kind);
    } catch (err) {
      if (mounted.current) {
        setFeedback({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <div className={styles.recAdmin} data-testid="message-admin-controls">
      {flaggedForReview && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busy === 'flag'}
          disabled={busy !== null}
          onClick={() =>
            void run('flag', () => clearMessageFlag(messageId), 'Review flag cleared.')
          }
        >
          Clear review flag
        </Button>
      )}
      {admin && (
        <>
          <label className={styles.recAdminBackend}>
            <span className="sr-only">Delete reason (optional, audited)</span>
            <input
              type="text"
              aria-label="Delete reason"
              placeholder="reason (optional)"
              value={reason}
              disabled={busy !== null}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <Button
            type="button"
            variant="danger"
            size="sm"
            loading={busy === 'delete'}
            disabled={busy !== null}
            onClick={() => {
              if (
                !window.confirm('Soft-delete this message? It will be hidden from public view.')
              ) {
                return;
              }
              void run(
                'delete',
                () => softDeleteMessage(messageId, reason.trim() || undefined),
                'Message soft-deleted.',
              );
            }}
          >
            Delete message
          </Button>
        </>
      )}
      {feedback && (
        <span
          className={feedback.tone === 'ok' ? styles.recAdminOk : styles.recAdminErr}
          role={feedback.tone === 'err' ? 'alert' : 'status'}
        >
          {feedback.text}
        </span>
      )}
    </div>
  );
}
