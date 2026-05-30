/**
 * Re-run the AI parse on a recording's stored transcript (#566).
 *
 * Calls the `reparseRecording` AppSync mutation (moderator/admin only —
 * authz enforced server-side). Re-enqueues the recording's existing
 * `transcript` straight onto the linguistic queue, skipping preprocess +
 * transcribe. Use case: re-parse after a model/prompt change without
 * paying to re-transcribe the audio.
 */
import { getDataClient } from '@/lib/amplifyClient';

export async function reparseRecording(recordingId: string): Promise<void> {
  const client = getDataClient();
  // Group-gated mutation (admin/moderator) — must use the Cognito
  // userPool token; the default (guest/iam) auth returns Unauthorized.
  const res = await client.mutations.reparseRecording({ recordingId }, { authMode: 'userPool' });
  if (res.errors && res.errors.length > 0) {
    throw new Error(`reparseRecording failed: ${JSON.stringify(res.errors)}`);
  }
}
