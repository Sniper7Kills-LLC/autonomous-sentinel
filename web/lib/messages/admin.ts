'use client';

/**
 * Inline message/recording moderation wrappers (#721).
 *
 * Thin clients over the admin-only custom mutations so a moderator/admin
 * can act on a single entry straight from the message detail page without
 * a trip to the admin panel. Each rides the Cognito `userPool` token —
 * the default guest/iam auth returns Unauthorized on these group-gated
 * mutations. The server re-enforces authorization on every call; these
 * wrappers only shape the request + surface errors.
 */
import { getDataClient } from '@/lib/amplifyClient';

const USER_POOL = { authMode: 'userPool' as const };

type RawMutResult = { errors?: { message: string }[] | null };

function throwOnErrors(res: RawMutResult, op: string): void {
  if (res.errors && res.errors.length > 0) {
    throw new Error(`${op} failed: ${res.errors.map((e) => e.message).join('; ')}`);
  }
}

type MutFn = (
  input: Record<string, unknown>,
  opts: Record<string, unknown>,
) => Promise<RawMutResult>;

/** Admin-only `softDeleteMessage` (#28). Hides the Message from public view. */
export async function softDeleteMessage(messageId: string, reason?: string): Promise<void> {
  const client = getDataClient();
  const fn = client.mutations.softDeleteMessage as unknown as MutFn;
  const res = await fn({ messageId, ...(reason ? { reason } : {}) }, USER_POOL);
  throwOnErrors(res, 'softDeleteMessage');
}

/** Admin-only `softDeleteRecording` (#29). Soft-deletes the row + hard-deletes S3 objects. */
export async function softDeleteRecording(recordingId: string, reason?: string): Promise<void> {
  const client = getDataClient();
  const fn = client.mutations.softDeleteRecording as unknown as MutFn;
  const res = await fn({ recordingId, ...(reason ? { reason } : {}) }, USER_POOL);
  throwOnErrors(res, 'softDeleteRecording');
}
