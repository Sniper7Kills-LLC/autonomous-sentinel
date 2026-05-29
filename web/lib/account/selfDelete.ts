'use client';

import { getDataClient } from '@/lib/amplifyClient';

interface SelfDeleteResult {
  id: string;
  piiBlanked: boolean | null;
  piiBlankedAt: string | null;
}

type RawSelfDelete = {
  data?: {
    id?: string;
    piiBlanked?: boolean | null;
    piiBlankedAt?: string | null;
  } | null;
  errors?: { message: string }[] | null;
};

/**
 * Calls the `selfDelete` server mutation (#101 / #430).
 *
 * Server idempotently blanks `email` / `preferredUsername` /
 * `displayName`, flips `piiBlanked=true`, writes an
 * `USER_PII_BLANK` AuditLog entry. The caller's User row stays
 * (Cognito sub retained as FK), but every PII column is null.
 *
 * Cognito user + active sessions are NOT torn down by this
 * mutation — owner-driven sign-out from the UI handles the
 * session side after the row blank lands.
 */
export async function selfDelete(): Promise<SelfDeleteResult> {
  const client = getDataClient();
  const submitFn = client.mutations.selfDelete as unknown as (
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<RawSelfDelete>;
  const raw = await submitFn({}, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data?.id) {
    throw new Error('selfDelete: empty response');
  }
  return {
    id: raw.data.id,
    piiBlanked: raw.data.piiBlanked ?? null,
    piiBlankedAt: raw.data.piiBlankedAt ?? null,
  };
}
