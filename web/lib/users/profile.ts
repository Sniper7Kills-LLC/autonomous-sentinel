'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Public user profile data access + normalization (#85).
 *
 * The backend surface is two reads, both public:
 *   - `getUserPublic(cognitoSub)` (Lambda, #271) — returns the User row
 *     with `email` / `preferredUsername` / `displayName` nulled when
 *     `piiBlanked=true` for non-admin callers. Does NOT carry any
 *     denormalized submission counts (the User model has none).
 *   - `Reputation.get({ userId })` (#36) — public-readable cache of
 *     `computedWeight` / `validatedSubmissions` / `acceptedCorrections`.
 *     This is the truthful source of submission stats; the profile shows
 *     these rather than scanning the (unbounded) Recording/Comment lists.
 *
 * Supporter-badge data lives on the `Donation` model, which is
 * owner/admin-read only (no public surface). So the badge is NOT
 * fetched or rendered here — see #106 (supporter badge display) for the
 * public badge surface once a public badge-state read exists.
 */

export type UserRole = 'admin' | 'moderator' | 'member';

const USER_ROLES: readonly UserRole[] = ['admin', 'moderator', 'member'];

function isUserRole(v: unknown): v is UserRole {
  return typeof v === 'string' && (USER_ROLES as readonly string[]).includes(v);
}

/** Normalized, render-ready public profile. */
export interface DisplayProfile {
  /** Cognito sub — the User primary key + the `?id=` query param. */
  id: string;
  /** Best display label: displayName → preferredUsername → null. */
  displayName: string | null;
  /** Public handle (preferredUsername), when set. */
  handle: string | null;
  role: UserRole;
  /** Account-created timestamp (ISO), when the row carries one. */
  joinedAt: string | null;
  /** True once the user has self-deleted (PII blanked). */
  piiBlanked: boolean;
  /** Free-text user-authored bio, when set. */
  bio: string | null;
  /** S3 key of the avatar image, when set. Resolve via `resolveAvatarUrl`. */
  avatarKey: string | null;
  /**
   * Reputation-derived public stats. `null` when the user has no
   * Reputation row yet (fresh account before first recompute).
   */
  reputation: ReputationStats | null;
}

export interface ReputationStats {
  /** Vote weight (1..5). */
  computedWeight: number;
  validatedSubmissions: number;
  acceptedCorrections: number;
}

type RawWrapper<T> = {
  data?: T | null;
  errors?: { message: string }[] | null;
};

export type RawUserPublic = {
  cognitoSub?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  role?: string | null;
  piiBlanked?: boolean | null;
  createdAt?: string | null;
  bio?: string | null;
  avatarKey?: string | null;
};

export type RawReputation = {
  computedWeight?: number | null;
  validatedSubmissions?: number | null;
  acceptedCorrections?: number | null;
};

/** Pure: shape the `getUserPublic` row into a `DisplayProfile`. */
export function toDisplayProfile(
  row: RawUserPublic,
  reputation: RawReputation | null,
): DisplayProfile {
  return {
    id: row.cognitoSub ?? '',
    displayName: row.displayName ?? row.preferredUsername ?? null,
    handle: row.preferredUsername ?? null,
    role: isUserRole(row.role) ? row.role : 'member',
    joinedAt: row.createdAt ?? null,
    piiBlanked: Boolean(row.piiBlanked),
    bio: row.bio ?? null,
    avatarKey: row.avatarKey ?? null,
    reputation: reputation ? toReputationStats(reputation) : null,
  };
}

/** Pure: shape a Reputation row into public stats. */
export function toReputationStats(r: RawReputation): ReputationStats {
  return {
    computedWeight: typeof r.computedWeight === 'number' ? r.computedWeight : 1,
    validatedSubmissions: typeof r.validatedSubmissions === 'number' ? r.validatedSubmissions : 0,
    acceptedCorrections: typeof r.acceptedCorrections === 'number' ? r.acceptedCorrections : 0,
  };
}

/**
 * Fetch + normalize a public profile by Cognito sub.
 *
 * Returns `null` when no User row exists for the id. A self-deleted
 * (PII-blanked) row still resolves — the page renders the
 * deactivated-account empty state from `profile.piiBlanked`.
 *
 * Reputation is fetched best-effort: a missing row (fresh account) or a
 * read failure degrades to `reputation: null` rather than failing the
 * whole profile load.
 */
export async function getProfile(id: string): Promise<DisplayProfile | null> {
  const trimmed = id.trim();
  if (!trimmed) return null;

  const client = getDataClient();
  const authMode = await resolveAuthMode();

  const getUserPublic = client.queries.getUserPublic as unknown as (
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<RawWrapper<RawUserPublic>>;
  const userRes = await getUserPublic({ cognitoSub: trimmed }, { authMode });
  if (userRes.errors?.length) {
    throw new Error(userRes.errors.map((e) => e.message).join('; '));
  }
  if (!userRes.data) return null;

  const reputation = await fetchReputation(trimmed, authMode);
  return toDisplayProfile(userRes.data, reputation);
}

async function fetchReputation(
  userId: string,
  authMode: 'identityPool' | 'userPool',
): Promise<RawReputation | null> {
  try {
    const client = getDataClient();
    // The Amplify Gen 2 generated `Schema` type does not resolve when
    // eslint runs from monorepo root (cross-workspace import path is
    // outside web/'s tsconfigRootDir), so the model accessor surfaces as
    // an unresolvable type. Funnel the whole models map through `unknown`
    // and re-type the one call to the structural shape we need — same
    // strategy as `lib/messages/query.ts`.
    const models = client.models as unknown as {
      Reputation: {
        get: (
          input: Record<string, unknown>,
          opts: Record<string, unknown>,
        ) => Promise<RawWrapper<RawReputation>>;
      };
    };
    const res = await models.Reputation.get({ userId }, { authMode });
    if (res.errors?.length || !res.data) return null;
    return res.data;
  } catch {
    return null;
  }
}

/**
 * Update the caller's own profile via the owner-only `updateProfile`
 * mutation (#736). All fields are optional; only the provided ones are
 * written. Always uses the Cognito `userPool` token — the mutation is
 * owner-gated server-side, so a guest call returns Unauthorized.
 *
 * The generated `Schema` mutations map does not resolve under the
 * monorepo-root eslint pass (cross-workspace import path), so the call is
 * funnelled through the same `as unknown as {...}` structural cast used in
 * `lib/dlq/query.ts`.
 */
export async function updateMyProfile(input: {
  displayName?: string;
  preferredUsername?: string;
  bio?: string;
  avatarKey?: string;
}): Promise<void> {
  const client = getDataClient();
  const mutateFn = (
    client.mutations as unknown as {
      updateProfile: (
        input: {
          displayName?: string;
          preferredUsername?: string;
          bio?: string;
          avatarKey?: string;
        },
        opts: { authMode: 'userPool' },
      ) => Promise<RawWrapper<unknown>>;
    }
  ).updateProfile;
  const res = await mutateFn(input, { authMode: 'userPool' });
  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join('; '));
  }
}

/**
 * Resolve an S3 avatar key to a display URL via Amplify Storage.
 *
 * Returns `null` for a null/empty key. The `aws-amplify/storage` import is
 * dynamic so it stays out of the initial bundle for profiles without an
 * avatar.
 */
export async function resolveAvatarUrl(avatarKey: string | null): Promise<string | null> {
  if (!avatarKey) return null;
  const { getUrl } = await import('aws-amplify/storage');
  return (await getUrl({ path: avatarKey })).url.toString();
}
