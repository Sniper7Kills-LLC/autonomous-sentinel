'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Field, Textarea } from '@/components/ui/Field';
import {
  acceptTranscriptRevision,
  castRevisionVote,
  listRevisionsForRecording,
  submitTranscriptRevision,
  type DisplayRevision,
  type RevisionVoteValue,
} from '@/lib/revisions/query';
import { isModeratorOrAdmin } from '@/lib/auth/roles';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import { diffTranscript, hasChanges, type DiffSegment } from '@/lib/revisions/diff';
import { containsProfanity } from '@/lib/moderation/profanity';
import styles from './RevisionPanel.module.css';

interface RevisionPanelProps {
  recordingId: string;
  /** Whether the parent Recording's transcript landed as failed.
   *  Gates the submission form per CLAUDE.md "Manual transcription"
   *  rule (server-side `submitTranscriptRevision` enforces the same
   *  constraint). */
  transcriptionFailed: boolean;
  /** True when the visitor has a signed-in session (controls whether
   *  the submission form + vote buttons are interactive). */
  signedIn: boolean;
  /** Current best transcript text for the Recording. When present (and
   *  the transcript did NOT fail), the success-case "Suggest a
   *  correction" form (#93) is offered; pre-fills the editor + drives
   *  the diff view. */
  transcript?: string | null;
}

/**
 * Composite panel for transcript revisions on a single Recording:
 *
 * - Lists every `TranscriptRevision` row for the Recording, with
 *   per-revision up/down vote buttons (#97). Accepted revisions are
 *   highlighted; superseded revisions render at reduced opacity.
 * - When `transcriptionFailed=true` AND the visitor is signed in,
 *   exposes a "Submit transcript" form that calls
 *   `submitTranscriptRevision` (#95).
 *
 * Successful-transcript Recordings never see the submission form —
 * corrections on those go through comments per the CLAUDE.md
 * "Comments / corrections on successfully-transcribed recordings"
 * rule.
 */
export function RevisionPanel({
  recordingId,
  transcriptionFailed,
  signedIn,
  transcript,
}: RevisionPanelProps) {
  const [revisions, setRevisions] = useState<DisplayRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Moderator/admin gate for the Accept control. Server enforces the
  // same authorization on `acceptTranscriptRevision`; this only decides
  // what to render (#654, mirrors the #505 reprocess-button pattern).
  const { groups } = useCallerGroups();
  const canAccept = isModeratorOrAdmin(groups);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const rows = await listRevisionsForRecording(recordingId);
      setRevisions(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [recordingId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className={styles.panel} aria-label="Transcript revisions">
      <header className={styles.header}>
        <h4 className={styles.heading}>Transcript revisions</h4>
        <span className={styles.subtle}>
          {loading ? 'Loading…' : `${revisions.length} on record`}
        </span>
      </header>

      {transcriptionFailed && signedIn && (
        <SubmitRow
          recordingId={recordingId}
          onSubmitted={() => {
            void refresh();
          }}
        />
      )}

      {!transcriptionFailed && (transcript ?? '').trim().length > 0 && (
        <CorrectionAffordance
          // Key by recordingId so the affordance (and any open
          // CorrectionForm + its draft) fully remounts when the parent
          // re-renders for a different recording — never carries a stale
          // draft against a new transcript.
          key={recordingId}
          recordingId={recordingId}
          currentTranscript={(transcript ?? '').trim()}
          signedIn={signedIn}
          onSubmitted={() => {
            void refresh();
          }}
        />
      )}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      {!loading && revisions.length === 0 && (
        <div className={styles.empty}>
          {transcriptionFailed
            ? 'No revisions yet. Be the first to propose one.'
            : 'No alternate transcripts submitted for this recording.'}
        </div>
      )}

      {revisions.length > 0 && (
        <RevisionRows
          revisions={revisions}
          canVote={signedIn}
          canAccept={canAccept}
          refresh={refresh}
          setError={setError}
        />
      )}
    </section>
  );
}

interface RevisionRowsProps {
  revisions: DisplayRevision[];
  canVote: boolean;
  canAccept: boolean;
  refresh: () => Promise<void>;
  setError: (msg: string | null) => void;
}

/**
 * Render-list wrapper that owns the single-flight vote guard. While
 * `votingId` is non-null, every row's `canVote` flips false so a
 * rapid second click does not re-submit before the resolver returns
 * + the refresh fetches the new tally. The same `acceptingId` guard
 * serialises Accept clicks (#654).
 */
function RevisionRows({ revisions, canVote, canAccept, refresh, setError }: RevisionRowsProps) {
  const [votingId, setVotingId] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const handleVote = useCallback(
    async (revisionId: string, value: RevisionVoteValue) => {
      if (votingId) return;
      setVotingId(revisionId);
      try {
        setError(null);
        await castRevisionVote(revisionId, value);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setVotingId(null);
      }
    },
    [votingId, refresh, setError],
  );
  const handleAccept = useCallback(
    async (revisionId: string) => {
      if (acceptingId) return;
      if (
        typeof window !== 'undefined' &&
        !window.confirm(
          'Accept this revision as the transcript? Other proposals will be superseded.',
        )
      ) {
        return;
      }
      setAcceptingId(revisionId);
      try {
        setError(null);
        await acceptTranscriptRevision(revisionId);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAcceptingId(null);
      }
    },
    [acceptingId, refresh, setError],
  );
  return (
    <div className={styles.list}>
      {sortRevisions(revisions).map((rev) => (
        <RevisionRow
          key={rev.id}
          revision={rev}
          canVote={canVote && votingId === null}
          canAccept={canAccept && acceptingId === null}
          onVote={(value) => {
            void handleVote(rev.id, value);
          }}
          onAccept={() => {
            void handleAccept(rev.id);
          }}
        />
      ))}
    </div>
  );
}

function sortRevisions(rows: DisplayRevision[]): DisplayRevision[] {
  // Accepted first, then by voteScore desc, then by createdAt desc.
  return [...rows].sort((a, b) => {
    if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
    if (a.voteScore !== b.voteScore) return b.voteScore - a.voteScore;
    const at = a.createdAt ?? '';
    const bt = b.createdAt ?? '';
    return bt.localeCompare(at);
  });
}

interface RevisionRowProps {
  revision: DisplayRevision;
  canVote: boolean;
  canAccept: boolean;
  onVote: (value: RevisionVoteValue) => void;
  onAccept: () => void;
}

function RevisionRow({ revision, canVote, canAccept, onVote, onAccept }: RevisionRowProps) {
  // Accept is only meaningful on a live (non-accepted, non-superseded)
  // proposal; the server is idempotent on already-accepted rows.
  const showAccept = canAccept && !revision.accepted && !revision.superseded;
  const cls = [
    styles.rev,
    revision.accepted ? styles.revAccepted : '',
    revision.superseded ? styles.revSuperseded : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article className={cls} data-revision-id={revision.id}>
      <div className={styles.voteCol}>
        <button
          type="button"
          className={`${styles.voteBtn} ${styles.voteBtnUp}`}
          onClick={() => onVote('UP')}
          disabled={!canVote}
          aria-label="Vote up"
          title="Vote up"
        >
          ▲
        </button>
        <span className={styles.score} aria-label={`Score ${revision.voteScore}`}>
          {formatScore(revision.voteScore)}
        </span>
        <button
          type="button"
          className={`${styles.voteBtn} ${styles.voteBtnDown}`}
          onClick={() => onVote('DOWN')}
          disabled={!canVote}
          aria-label="Vote down"
          title="Vote down"
        >
          ▼
        </button>
      </div>
      <div className={styles.revBody}>
        <p className={styles.revText}>{revision.proposedText}</p>
        <div className={styles.revMeta}>
          {revision.accepted && (
            <span className={`${styles.tag} ${styles.tagAccepted}`}>ACCEPTED</span>
          )}
          {revision.superseded && <span className={styles.tag}>SUPERSEDED</span>}
          {revision.source && <span className={styles.tag}>{revision.source}</span>}
          {revision.proposedBy && (
            <span className={styles.subtle} title={`Proposed by ${revision.proposedBy}`}>
              by {shortId(revision.proposedBy)}
            </span>
          )}
          {revision.createdAt && <span>{formatTs(revision.createdAt)}</span>}
        </div>
        {showAccept && (
          <div className={styles.revActions}>
            <Button variant="success" size="sm" onClick={onAccept}>
              Accept
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

/** Short, human-scannable form of a Cognito sub for attribution. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

interface SubmitRowProps {
  recordingId: string;
  onSubmitted: () => void;
}

function SubmitRow({ recordingId, onSubmitted }: SubmitRowProps) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!draft.trim()) {
      setError('Please paste your proposed transcript before submitting.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await submitTranscriptRevision(recordingId, draft.trim());
      setDraft('');
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [draft, recordingId, onSubmitted]);

  return (
    <div>
      <p className={styles.notice}>
        Whisper could not transcribe this recording. Submit what you hear — it lands as a `MANUAL`
        revision under community vote.
      </p>
      <form
        noValidate
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-label="Submit transcript revision"
      >
        <Field label="Proposed transcript" htmlFor={`rev-text-${recordingId}`}>
          <Textarea
            id={`rev-text-${recordingId}`}
            rows={4}
            value={draft}
            placeholder="e.g. SKYKING SKYKING DO NOT ANSWER PT3 14 AB"
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <div className={styles.formActions}>
          <Button type="submit" size="sm" loading={submitting} disabled={submitting}>
            Submit transcript
          </Button>
        </div>
      </form>
    </div>
  );
}

interface CorrectionAffordanceProps {
  recordingId: string;
  currentTranscript: string;
  signedIn: boolean;
  onSubmitted: () => void;
}

/**
 * Success-case correction entry point (#93).
 *
 * Unlike `SubmitRow` (which is gated to `transcriptionFailed` recordings,
 * the manual-transcription path of #95), this is the "I heard it
 * differently" affordance for recordings that DID transcribe. It grows the
 * fine-tune corpus per CLAUDE.md → ML feedback loop. Signed-out visitors
 * see a sign-in prompt instead of the editor, mirroring how the rest of
 * the panel gates on `signedIn`.
 */
function CorrectionAffordance({
  recordingId,
  currentTranscript,
  signedIn,
  onSubmitted,
}: CorrectionAffordanceProps) {
  const [open, setOpen] = useState(false);

  if (!signedIn) {
    return (
      <p className={styles.notice}>
        Heard it differently? <Link href="/sign-in">Sign in</Link> to suggest a transcript
        correction for community vote.
      </p>
    );
  }

  if (!open) {
    return (
      <div className={styles.formActions}>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Suggest a correction
        </Button>
      </div>
    );
  }

  return (
    <CorrectionForm
      recordingId={recordingId}
      currentTranscript={currentTranscript}
      onClose={() => setOpen(false)}
      onSubmitted={() => {
        onSubmitted();
      }}
    />
  );
}

interface CorrectionFormProps {
  recordingId: string;
  currentTranscript: string;
  onClose: () => void;
  onSubmitted: () => void;
}

/** Max accepted length: current transcript length × 1.5 (sanity guard). */
function maxCorrectionLength(current: string): number {
  return Math.ceil(current.length * 1.5);
}

function CorrectionForm({
  recordingId,
  currentTranscript,
  onClose,
  onSubmitted,
}: CorrectionFormProps) {
  const [draft, setDraft] = useState(currentTranscript);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const segments: DiffSegment[] = diffTranscript(currentTranscript, draft);
  const maxLen = maxCorrectionLength(currentTranscript);

  const submit = useCallback(async () => {
    const next = draft.trim();
    if (!next) {
      setError('Please enter your corrected transcript before submitting.');
      return;
    }
    if (next === currentTranscript.trim()) {
      setError('Your text matches the current transcript — make a change before submitting.');
      return;
    }
    if (next.length > maxLen) {
      setError(
        `That is much longer than the current transcript (max ${maxLen} characters). Trim it down.`,
      );
      return;
    }
    if (containsProfanity(next)) {
      // Client-side wordlist pre-check only. Authoritative AWS Comprehend
      // confirmation runs server-side in the resolver — out of scope here,
      // tracked under #99 / #287.
      setError('Your correction tripped the language filter. Please revise and try again.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // NOTE: `submitTranscriptRevision` accepts only (recordingId, text).
      // The optional justification field from #93 is deferred until the
      // backend mutation grows a justification param — see #93.
      await submitTranscriptRevision(recordingId, next);
      setDone(true);
      onSubmitted();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /rate.?limit|too many|throttl/i.test(msg)
          ? 'You have hit the correction rate limit. Please wait a bit and try again.'
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  }, [draft, currentTranscript, maxLen, recordingId, onSubmitted]);

  const cancel = useCallback(() => {
    const dirty = draft.trim() !== currentTranscript.trim();
    if (dirty && !window.confirm('Discard your correction? Your changes will be lost.')) {
      return;
    }
    onClose();
  }, [draft, currentTranscript, onClose]);

  if (done) {
    return (
      <div className={styles.success} role="status">
        Thanks — your suggestion is up for community vote. See it in the list below.
      </div>
    );
  }

  return (
    <div>
      <p className={styles.notice}>
        Suggest a correction. Your edit lands as a `CORRECTION` revision under community vote — it
        does not overwrite the current transcript.
      </p>
      <form
        noValidate
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-label="Suggest a transcript correction"
      >
        <div className={styles.correctPanes}>
          <div>
            <p className={styles.paneLabel} id={`cur-label-${recordingId}`}>
              Current transcript
            </p>
            <p className={styles.currentText} aria-labelledby={`cur-label-${recordingId}`}>
              {currentTranscript}
            </p>
          </div>
          <div>
            <Field label="Your correction" htmlFor={`correct-text-${recordingId}`}>
              <Textarea
                id={`correct-text-${recordingId}`}
                rows={6}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div>
          <p className={styles.paneLabel}>Changes</p>
          {hasChanges(segments) ? (
            <div className={styles.diffBox} aria-label="Diff of your changes">
              {segments.map((seg, i) => {
                // Stable-ish key per segment: index + op marker + length.
                // The list is fully recomputed each render, but a more
                // descriptive key than the bare index avoids reconciliation
                // surprises when adjacent segments change op.
                const mark = seg.op === 'added' ? '+' : seg.op === 'removed' ? '-' : '=';
                const key = `${i}-${mark}-${seg.value.length}`;
                if (seg.op === 'added') {
                  return (
                    <ins key={key} className={styles.diffAdded}>
                      {seg.value}
                    </ins>
                  );
                }
                if (seg.op === 'removed') {
                  return (
                    <del key={key} className={styles.diffRemoved}>
                      {seg.value}
                    </del>
                  );
                }
                return <span key={key}>{seg.value}</span>;
              })}
            </div>
          ) : (
            <p className={styles.subtle}>No changes yet — edit the text to propose a correction.</p>
          )}
        </div>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        <div className={styles.formActions}>
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={submitting} disabled={submitting}>
            Submit correction
          </Button>
        </div>
      </form>
    </div>
  );
}

function formatScore(score: number): string {
  if (Math.abs(score) < 0.05) return '0';
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}
