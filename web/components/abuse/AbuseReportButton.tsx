'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { submitAbuseReport, type AbuseReason, type AbuseTargetType } from '@/lib/abuse/query';
import styles from './AbuseReportButton.module.css';

interface AbuseReportButtonProps {
  /** The polymorphic target entity to report. */
  targetType: AbuseTargetType;
  /** ID of the target entity (Message id, Recording id, etc.). */
  targetId: string;
  /** Cognito sub of the signed-in caller. Hides the button when null. */
  reporterId: string | null;
  /** Optional label override (default: "Report"). */
  label?: string;
}

const REASONS: Array<{ value: AbuseReason; label: string }> = [
  { value: 'SPAM', label: 'Spam / promotional' },
  { value: 'OFFENSIVE', label: 'Offensive or hateful' },
  { value: 'WRONG_INFO', label: 'Misinformation' },
  { value: 'IMPERSONATION', label: 'Impersonation' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * `<AbuseReportButton>` — opens a small popover with a reason
 * select + notes textarea, posts an `AbuseReport` row via the
 * auto-generated `createAbuseReport` mutation (#99).
 *
 * Guests (reporterId === null) get no button — the model authz is
 * `allow.authenticated().to(['create'])`, so guests can't create a
 * report anyway.
 */
export function AbuseReportButton({
  targetType,
  targetId,
  reporterId,
  label,
}: AbuseReportButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<AbuseReason>('SPAM');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const submit = useCallback(async () => {
    if (!reporterId) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitAbuseReport({
        targetType,
        targetId,
        reporterId,
        reason,
        notes,
      });
      setSubmitted(true);
      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [notes, reason, reporterId, targetId, targetType]);

  if (!reporterId) return null;

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => {
          setSubmitted(false);
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {label ?? 'Report'}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label={`Report ${targetType.toLowerCase()}`}
          className={styles.popover}
        >
          <div className={styles.popoverHead}>
            <span>Report {targetType.toLowerCase()}</span>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => setOpen(false)}
              aria-label="Close report popover"
            >
              ×
            </button>
          </div>
          {submitted ? (
            <p className={styles.success} role="status">
              Thanks — a moderator will review this.
            </p>
          ) : (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className={styles.field}>
                <label htmlFor={`abuse-reason-${targetType}-${targetId}`} className={styles.label}>
                  Reason
                </label>
                <select
                  id={`abuse-reason-${targetType}-${targetId}`}
                  className={styles.input}
                  value={reason}
                  onChange={(e) => setReason(e.target.value as AbuseReason)}
                >
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor={`abuse-notes-${targetType}-${targetId}`} className={styles.label}>
                  Notes (optional)
                </label>
                <textarea
                  id={`abuse-notes-${targetType}-${targetId}`}
                  className={styles.textarea}
                  rows={3}
                  maxLength={500}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What should the mod know?"
                />
              </div>
              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}
              <p className={styles.notice}>
                Reports are visible to moderators only. Reporter identity is recorded for audit.
              </p>
              <div className={styles.actions}>
                <Button type="submit" size="sm" loading={submitting} disabled={submitting}>
                  Send report
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </span>
  );
}
