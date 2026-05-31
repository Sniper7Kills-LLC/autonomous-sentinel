/**
 * Reprocess a recording from its stored audio (#505).
 *
 * Calls the `reprocessRecording` AppSync mutation (moderator/admin
 * only — authz enforced server-side). Resets the recording to QUEUED
 * and re-runs the full pipeline from the already-stored original; no
 * re-upload of audio is needed.
 *
 * Optional `backend` (#592) picks which transcription backend re-runs
 * (CLAUDE.md: "admin can re-run a single recording on a different
 * backend for comparison"). Omitted → the server defaults to
 * `whisper-local`. The server re-validates the value.
 */
import { getDataClient } from '@/lib/amplifyClient';

export async function reprocessRecording(recordingId: string, backend?: string): Promise<void> {
  const client = getDataClient();
  // Group-gated mutation (admin/moderator) — must use the Cognito
  // userPool token; the default (guest/iam) auth returns Unauthorized.
  const res = await client.mutations.reprocessRecording(
    { recordingId, ...(backend ? { backend } : {}) },
    { authMode: 'userPool' },
  );
  if (res.errors && res.errors.length > 0) {
    throw new Error(`reprocessRecording failed: ${JSON.stringify(res.errors)}`);
  }
}
