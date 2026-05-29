/**
 * Reprocess a recording from its stored audio (#505).
 *
 * Calls the `reprocessRecording` AppSync mutation (moderator/admin
 * only — authz enforced server-side). Resets the recording to QUEUED
 * and re-runs the full pipeline from the already-stored original; no
 * re-upload of audio is needed.
 */
import { getDataClient } from '@/lib/amplifyClient';

export async function reprocessRecording(recordingId: string): Promise<void> {
  const client = getDataClient();
  // Group-gated mutation (admin/moderator) — must use the Cognito
  // userPool token; the default (guest/iam) auth returns Unauthorized.
  const res = await client.mutations.reprocessRecording({ recordingId }, { authMode: 'userPool' });
  if (res.errors && res.errors.length > 0) {
    throw new Error(`reprocessRecording failed: ${JSON.stringify(res.errors)}`);
  }
}
