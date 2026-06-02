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
    if (!open || !signedIn) return;
    void refresh();
    // Re-sync the form draft to the current parsed value each time
    // the popover opens — keeps a stale typed value from a prior
    // open out of view (the post-cast reset path uses the same
    // baseline).
    setDraft(currentValue ?? '');
  }, [open, signedIn, refresh, currentValue]);

  // Close on outside click for tidy popover semantics.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // Cast a vote for an EXPLICIT value — shared by the free-form
  // "suggest a value" form and the per-row "endorse this suggestion"
  // buttons (#668), so endorsing someone else's BODY suggestion is one
  // click instead of re-typing the whole transcript.
  const castValue = useCallback(
    async (rawValue: string) => {
      if (voting) return;
      const value = rawValue.trim();
      if (!value) {
        setError('Enter a value before submitting.');
        return;
      }
      setVoting(true);
      setError(null);
      try {
        await castFieldVote(messageId, field, value);
        await refresh();
        // Reset the draft to the canonical baseline so a re-cast
        // starts fresh rather than from the last-typed text.
        setDraft(currentValue ?? '');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setVoting(false);
      }
    },
    [currentValue, field, messageId, refresh, voting],
  );

  return (
    <span className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          currentValue
            ? `Vote on ${FIELD_LABELS[field]} (current: ${currentValue})`
            : `Vote on ${FIELD_LABELS[field]} (currently empty)`
        }
      >
        {currentValue ? `Vote ${FIELD_LABELS[field]}` : `Vote ${FIELD_LABELS[field]} (empty)`}
      </button>
      {open && (
        <div
          // Non-modal popover — background interaction stays live, so
          // signal non-modality explicitly. Full focus-trap modal
          // semantics are a deliberate non-goal at v1.
          role="dialog"
          aria-modal="false"
          aria-label={`Vote on ${FIELD_LABELS[field]}`}
          className={styles.popover}
        >
          <div className={styles.popHead}>
            <span>
              {FIELD_LABELS[field]}
              {' · '}
              <em className={styles.popHeadValue}>
                {currentValue && currentValue.length > 0 ? currentValue : '(empty)'}
              </em>
            </span>
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
              <TallyView
                tally={tally}
                loading={loading}
                currentValue={currentValue}
                voting={voting}
                onVote={(value) => {
                  void castValue(value);
                }}
              />
              <form
                noValidate
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  void castValue(draft);
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
  /** True while a cast is in flight — disables the per-row endorse buttons. */
  voting: boolean;
  /** Endorse an already-suggested value with one click (#668). */
  onVote: (value: string) => void;
}

function TallyView({ tally, loading, currentValue, voting, onVote }: TallyViewProps) {
  if (loading && !tally) {
    return <div className={styles.empty}>Loading tally…</div>;
  }
  if (!tally || tally.entries.length === 0) {
    return <div className={styles.empty}>No votes yet — you can be first.</div>;
  }
  const leader = tally.entries[0]?.value;
  return (
    <ul className={styles.tally}>
      {tally.entries.map((entry) => (
        <li className={styles.tallyRow} key={entry.value}>
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
          {/* One-click endorse — vote for this exact value without re-typing. */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={voting || entry.value.length === 0}
            onClick={() => onVote(entry.value)}
            aria-label={`Vote for "${entry.value || '(empty)'}"`}
          >
            Vote
          </Button>
        </li>
      ))}
    </ul>
  );
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}
