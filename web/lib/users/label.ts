'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';
import type { RawUserPublic } from './profile';

/**
 * Lightweight Cognito-sub → display-label resolution for attribution
 * surfaces (#721 — submitter / uploader lines on the message detail
 * page).
 *
 * Distinct from `getProfile` (`lib/users/profile.ts`): that helper also
 * fetches the Reputation row for the full profile page. Attribution
 * needs only the public display label, so this hits the single
 * `getUserPublic` read and skips the reputation round-trip.
 *
 * The `getUserPublic` Lambda (#271) nulls `displayName` /
 * `preferredUsername` when `piiBlanked = true` for non-admin callers,
 * so a self-deleted account resolves to the deactivated label rather
 * than leaking PII.
 */

/** A resolved attribution label + the linkable target sub. */
export interface UserLabel {
  /** The Cognito sub (the `?id=` query param on the profile route). */
  sub: string;
  /** Human label: displayName → preferredUsername → short sub. */
  label: string;
  /** True once the account has self-deleted (PII blanked). */
  piiBlanked: boolean;
}

/** Short, stable fallback when no public name is available. */
export function shortSub(sub: string): string {
  const trimmed = sub.trim();
  return trimmed.length > 12 ? `${trimmed.slice(0, 8)}…` : trimmed;
}

/** Pure: shape a `getUserPublic` row into an attribution label. */
export function toUserLabel(sub: string, row: RawUserPublic | null): UserLabel {
  const piiBlanked = Boolean(row?.piiBlanked);
  if (piiBlanked) {
    return { sub, label: 'deactivated account', piiBlanked: true };
  }
  const name = row?.displayName ?? row?.preferredUsername ?? null;
  return { sub, label: name ?? shortSub(sub), piiBlanked: false };
}

type RawWrapper<T> = {
  data?: T | null;
  errors?: { message: string }[] | null;
};

// Module-level cache so repeated subs on one page (e.g. the same
// uploader across multiple recordings) resolve once. Promise-valued so
// concurrent callers share a single in-flight request.
const cache = new Map<string, Promise<UserLabel>>();

/** Clear the resolution cache — test seam. */
export function clearUserLabelCache(): void {
  cache.clear();
}

/**
 * Resolve a Cognito sub to a public attribution label. Never throws:
 * a missing row or a read failure degrades to the short-sub fallback so
 * an attribution line never breaks the page.
 */
export async function getUserLabel(sub: string): Promise<UserLabel> {
  const trimmed = sub.trim();
  if (!trimmed) return { sub: '', label: 'unknown', piiBlanked: false };

  const cached = cache.get(trimmed);
  if (cached) return cached;

  const promise = fetchUserLabel(trimmed);
  cache.set(trimmed, promise);
  // Drop failed lookups from the cache so a transient error can retry.
  promise.catch(() => cache.delete(trimmed));
  return promise;
}

async function fetchUserLabel(sub: string): Promise<UserLabel> {
  try {
    const client = getDataClient();
    const authMode = await resolveAuthMode();
    const getUserPublic = client.queries.getUserPublic as unknown as (
      input: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) => Promise<RawWrapper<RawUserPublic>>;
    const res = await getUserPublic({ cognitoSub: sub }, { authMode });
    if (res.errors?.length || !res.data) {
      return toUserLabel(sub, null);
    }
    return toUserLabel(sub, res.data);
  } catch {
    return toUserLabel(sub, null);
  }
}
