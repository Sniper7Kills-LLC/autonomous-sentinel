'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Textarea } from '@/components/ui/Field';
import {
  castRevisionVote,
  listRevisionsForRecording,
  submitTranscriptRevision,
  type DisplayRevision,
  type RevisionVoteValue,
} from '@/lib/revisions/query';
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
export function RevisionPanel({ recordingId, transcriptionFailed, signedIn }: RevisionPanelProps) {
  const [revisions, setRevisions] = useState<DisplayRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        <div className={styles.list}>
          {sortRevisions(revisions).map((rev) => (
            <RevisionRow
              key={rev.id}
              revision={rev}
              canVote={signedIn}
              onVote={(value) => {
                void doVote(rev.id, value, refresh, setError);
              }}
            />
          ))}
        </div>
      )}
    </section>
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

async function doVote(
  revisionId: string,
  value: RevisionVoteValue,
  refresh: () => Promise<void>,
  setError: (msg: string | null) => void,
): Promise<void> {
  try {
    setError(null);
    await castRevisionVote(revisionId, value);
    await refresh();
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

interface RevisionRowProps {
  revision: DisplayRevision;
  canVote: boolean;
  onVote: (value: RevisionVoteValue) => void;
}

function RevisionRow({ revision, canVote, onVote }: RevisionRowProps) {
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
          {revision.createdAt && <span>{formatTs(revision.createdAt)}</span>}
        </div>
      </div>
    </article>
  );
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
