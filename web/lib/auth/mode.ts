'use client';

import { configureAmplifyOnce } from '@/lib/amplifyClient';

/**
 * Pick the right AppSync auth mode for the current session.
 *
 * Default `defineData` auth mode on this project is `identityPool`
 * (IAM-signed via Cognito Identity Pool). For guest visitors that's
 * correct — the unauth role carries the `appsync:GraphQL` grants that
 * `allow.guest()` rules generate.
 *
 * For signed-in callers it is NOT correct: identityPool routes users in
 * a Cognito group to a per-group IAM role (`amplifyAuth<X>GroupRole`)
 * which does not carry the per-group grant `allow.groups([...])`
 * generates. Amplify only writes the group grants into the User Pool
 * JWT — they're honoured at AppSync via the `userPool` auth mode.
 *
 * Resolution:
 *   - signed in  → `userPool`  (JWT group claim → group-rule pass)
 *   - signed out → `identityPool` (guest IAM grant)
 *
 * Cache the probe so each request doesn't re-trigger the dynamic
 * `aws-amplify/auth` import. The cache is per-session — sign-out
 * resets it back to unauth.
 */

type AppSyncAuthMode = 'identityPool' | 'userPool';

let cached: AppSyncAuthMode | null = null;

export async function resolveAuthMode(): Promise<AppSyncAuthMode> {
  if (cached) return cached;
  configureAmplifyOnce();
  try {
    const { getCurrentUser } = await import('aws-amplify/auth');
    await getCurrentUser();
    cached = 'userPool';
  } catch {
    cached = 'identityPool';
  }
  return cached;
}

/**
 * Synchronous getter for hot paths that have already resolved the
 * mode at least once. Defaults to `identityPool` when no resolution
 * has happened yet — callers should kick `resolveAuthMode()` once at
 * mount before using this.
 */
export function getCachedAuthMode(): AppSyncAuthMode {
  return cached ?? 'identityPool';
}

/**
 * Reset the cache — used by sign-out flows or by tests between
 * fixtures. The next `resolveAuthMode()` call re-probes the live
 * session.
 */
export function clearAuthModeCache(): void {
  cached = null;
}
