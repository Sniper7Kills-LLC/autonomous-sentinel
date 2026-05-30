'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { fetchCallerGroups, isModeratorOrAdmin } from '@/lib/auth/roles';
import { reprocessRecording } from '@/lib/uploads/reprocess';
import { reparseRecording } from '@/lib/uploads/reparse';
import styles from './MessageDetailView.module.css';

interface RecordingAdminControlsProps {
  recordingId: string;
  /**
   * Whether this recording has a stored transcript. The "Re-run AI"
   * control re-parses the existing transcript, so it is disabled when
   * there is nothing to re-parse (the server rejects it too).
   */
  hasTranscript: boolean;
}

type Feedback = { tone: 'ok' | 'err'; text: string } | null;

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
 * (`fetchCallerGroups` → `isModeratorOrAdmin`). The server enforces its
 * own authz on each mutation — this only decides what to render.
 */
export function RecordingAdminControls({
  recordingId,
  hasTranscript,
}: RecordingAdminControlsProps) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<null | 'reprocess' | 'reparse'>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const groups = await fetchCallerGroups();
        if (!cancelled) setVisible(isModeratorOrAdmin(groups));
      } catch {
        if (!cancelled) setVisible(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  async function run(
    kind: 'reprocess' | 'reparse',
    action: (id: string) => Promise<void>,
    okText: string,
  ): Promise<void> {
    setBusy(kind);
    setFeedback(null);
    try {
      await action(recordingId);
      setFeedback({ tone: 'ok', text: okText });
    } catch (err) {
      setFeedback({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.recAdmin} data-testid="recording-admin-controls">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={busy === 'reprocess'}
        disabled={busy !== null}
        onClick={() =>
          void run('reprocess', reprocessRecording, 'Reprocess queued — full pipeline re-running.')
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
            reparseRecording,
            'Re-parse queued — AI re-running on the transcript.',
          )
        }
      >
        Re-run AI (re-parse transcript)
      </Button>
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
