'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { MESSAGE_TYPES } from '@/lib/messages/filters';
import {
  castFieldVote,
  listFieldVotes,
  tallyFieldVotes,
  type FieldVoteField,
  type FieldVoteTally,
} from '@/lib/votes/query';
import styles from './FieldVoteAffordance.module.css';

interface FieldVoteAffordanceProps {
  messageId: string;
  field: FieldVoteField;
  /** Current value of the field on the parent Message — pre-fills
   *  the form so a "this looks right" confirmation vote takes one
   *  tap instead of a re-type. */
  currentValue: string | null;
  /** Signed-in flag — when false, only the trigger is rendered as a
   *  prompt-to-sign-in pointer; the popover is suppressed. */
  signedIn: boolean;
}

const FIELD_LABELS: Record<FieldVoteField, string> = {
  SENDER: 'SENDER',
  RECEIVER: 'RECEIVER',
  TYPE: 'TYPE',
  BODY: 'BODY',
};

/**
 * `<FieldVoteAffordance>` — per-field vote popover on the Message
 * header (#96). Authenticated visitors can suggest an alternative
 * value for the parsed `sender` / `receiver` / `type` / `body` and
 * see a live tally of weighted votes.
 *
 * Guests see the trigger button as a hint but the popover is
 * suppressed — the raw FieldVote rows are auth-only read per the
 * model authz (#33 deferred public aggregate resolver lands later).
 */
export function FieldVoteAffordance({
  messageId,
  field,
  currentValue,
  signedIn,
}: FieldVoteAffordanceProps) {
  const [open, setOpen] = useState(false);
  const [tally, setTally] = useState<FieldVoteTally | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>(currentValue ?? '');
  const [voting, setVoting] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listFieldVotes(messageId, field);
      setTally(tallyFieldVotes(rows));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [messageId, field]);

  useEffect(() => {
    if (open && signedIn) void refresh();
  }, [open, signedIn, refresh]);

  // Close on outside click for tidy popover semantics.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const submitVote = useCallback(async () => {
    if (voting) return;
    const value = draft.trim();
    if (!value) {
      setError('Enter a value before submitting.');
      return;
    }
    setVoting(true);
    setError(null);
    try {
      await castFieldVote(messageId, field, value);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVoting(false);
    }
  }, [draft, field, messageId, refresh, voting]);

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Vote on ${FIELD_LABELS[field]}`}
      >
        Vote {FIELD_LABELS[field]}
      </button>
      {open && (
        <div role="dialog" aria-label={`Vote on ${FIELD_LABELS[field]}`} className={styles.popover}>
          <div className={styles.popHead}>
            <span>{FIELD_LABELS[field]}</span>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => setOpen(false)}
              aria-label="Close vote popover"
            >
              ×
            </button>
          </div>

          {!signedIn ? (
            <p className={styles.notice}>
              Sign in to suggest a different value or see the per-value tally for this field.
            </p>
          ) : (
            <>
              <TallyView tally={tally} loading={loading} currentValue={currentValue} />
              <form
                noValidate
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitVote();
                }}
                aria-label={`Submit ${FIELD_LABELS[field]} vote`}
              >
                <label htmlFor={`fv-${messageId}-${field}`} className={styles.formLabel}>
                  Suggest value
                </label>
                <div className={styles.formRow}>
                  {field === 'TYPE' ? (
                    <select
                      id={`fv-${messageId}-${field}`}
                      className={styles.formInput}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    >
                      <option value="">…</option>
                      {MESSAGE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`fv-${messageId}-${field}`}
                      type="text"
                      className={styles.formInput}
                      value={draft}
                      placeholder={currentValue ?? ''}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                  )}
                  <Button type="submit" size="sm" loading={voting} disabled={voting}>
                    Cast
                  </Button>
                </div>
                {error && (
                  <div className={styles.error} role="alert">
                    {error}
                  </div>
                )}
              </form>
            </>
          )}
        </div>
      )}
    </span>
  );
}

interface TallyViewProps {
  tally: FieldVoteTally | null;
  loading: boolean;
  currentValue: string | null;
}

function TallyView({ tally, loading, currentValue }: TallyViewProps) {
  if (loading && !tally) {
    return <div className={styles.empty}>Loading tally…</div>;
  }
  if (!tally || tally.entries.length === 0) {
    return <div className={styles.empty}>No votes yet — you can be first.</div>;
  }
  const leader = tally.entries[0]?.value;
  return (
    <div className={styles.tally}>
      {tally.entries.map((entry) => (
        <div className={styles.tallyRow} key={entry.value}>
          <span
            className={`${styles.tallyValue} ${entry.value === leader ? styles.tallyValueLeader : ''}`}
            title={entry.value}
          >
            {entry.value || '(empty)'}
            {currentValue && entry.value === currentValue ? ' · current' : ''}
          </span>
          <span className={styles.tallyMeta}>weight {formatNum(entry.weight)}</span>
          <span className={styles.tallyMeta}>
            {entry.voterCount} voter{entry.voterCount === 1 ? '' : 's'}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}
