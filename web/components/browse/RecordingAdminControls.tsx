'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import { isAdmin, isModeratorOrAdmin } from '@/lib/auth/roles';
import { reprocessRecording } from '@/lib/uploads/reprocess';
import { reparseRecording } from '@/lib/uploads/reparse';
import { softDeleteRecording } from '@/lib/messages/admin';
import styles from './MessageDetailView.module.css';

interface RecordingAdminControlsProps {
  recordingId: string;
  /**
   * Whether this recording has a stored transcript. The "Re-run AI"
   * control re-parses the existing transcript, so it is disabled when
   * there is nothing to re-parse (the server rejects it too).
   */
  hasTranscript: boolean;
  /**
   * Called after a successful admin soft-delete so the parent can drop
   * this recording from the list (#721).
   */
  onDeleted?: () => void;
}

type Feedback = { tone: 'ok' | 'err'; text: string } | null;

/**
 * Selectable transcription backends for the Reprocess control (#592).
 * Only the two BUILT backends are offered — `whisper-api` + `bedrock`
 * are not implemented yet (see `transcribe-dispatch/selector.ts`
 * `TRANSCRIBE_BACKENDS`). The server re-validates the choice.
 */
const REPROCESS_BACKENDS = [
  { value: 'whisper-local', label: 'Whisper (local)' },
  { value: 'amazon-transcribe', label: 'Amazon Transcribe' },
] as const;

type ReprocessBackend = (typeof REPROCESS_BACKENDS)[number]['value'];

/**
 * Moderator/admin-only reprocess controls for a single recording (#566).
 *
 * Two buttons:
 *   - "Reprocess (re-transcribe + parse)" → `reprocessRecording` (#505):
 *     re-runs the FULL pipeline from the stored audio.
 *   - "Re-run AI (re-parse transcript)" → `reparseRecording` (#566):
 *     re-enqueues the stored transcript onto the linguistic queue only,
 *     skipping preprocess + transcribe.
 *
 * Hidden entirely for members/guests; the gate mirrors the Debug panel
 * (`useCallerGroups` → `isModeratorOrAdmin`). The server enforces its
 * own authz on each mutation — this only decides what to render.
 */
export function RecordingAdminControls({
  recordingId,
  hasTranscript,
  onDeleted,
}: RecordingAdminControlsProps) {
  const { groups } = useCallerGroups();
  const visible = isModeratorOrAdmin(groups);
  const admin = isAdmin(groups);
  const [busy, setBusy] = useState<null | 'reprocess' | 'reparse' | 'delete'>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Which transcription backend the Reprocess control re-runs on (#592).
  const [backend, setBackend] = useState<ReprocessBackend>('whisper-local');
  // Guards against a state update after the delete-success callback
  // unmounts this card (`onDeleted` drops the row from the parent list).
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!visible) return null;

  async function run(
    kind: 'reprocess' | 'reparse' | 'delete',
    action: () => Promise<void>,
    okText: string,
  ): Promise<void> {
    setBusy(kind);
    setFeedback(null);
    try {
      await action();
      if (mounted.current) setFeedback({ tone: 'ok', text: okText });
    } catch (err) {
      if (mounted.current) {
        setFeedback({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <div className={styles.recAdmin} data-testid="recording-admin-controls">
      <label className={styles.recAdminBackend}>
        <span className="sr-only">Transcription backend</span>
        <select
          aria-label="Transcription backend"
          data-testid="reprocess-backend-select"
          value={backend}
          disabled={busy !== null}
          onChange={(e) => setBackend(e.target.value as ReprocessBackend)}
        >
          {REPROCESS_BACKENDS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={busy === 'reprocess'}
        disabled={busy !== null}
        onClick={() =>
          void run(
            'reprocess',
            () => reprocessRecording(recordingId, backend),
            'Reprocess queued — full pipeline re-running.',
          )
        }
      >
        Reprocess (re-transcribe + parse)
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        loading={busy === 'reparse'}
        disabled={busy !== null || !hasTranscript}
        title={hasTranscript ? undefined : 'No stored transcript to re-parse'}
        onClick={() =>
          void run(
            'reparse',
            () => reparseRecording(recordingId),
            'Re-parse queued — AI re-running on the transcript.',
          )
        }
      >
        Re-run AI (re-parse transcript)
      </Button>
      {admin && (
        <Button
          type="button"
          variant="danger"
          size="sm"
          loading={busy === 'delete'}
          disabled={busy !== null}
          onClick={() => {
            if (
              !window.confirm(
                'Soft-delete this recording? The audio file is removed (recoverable for 30 days).',
              )
            ) {
              return;
            }
            void run(
              'delete',
              () => softDeleteRecording(recordingId).then(() => onDeleted?.()),
              'Recording soft-deleted.',
            );
          }}
        >
          Delete recording
        </Button>
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
