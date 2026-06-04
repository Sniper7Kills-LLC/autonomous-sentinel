'use client';

import { useAuth } from '@/components/auth/AuthProvider';

interface SessionState {
  loading: boolean;
  signedIn: boolean;
  username: string | null;
  /** Cognito user sub (UUID). Drives every `User.id = cognitoSub`
   *  query keyed off the caller — `Recording.uploaderId`,
   *  `Reputation.userId`, etc. */
  sub: string | null;
}

/**
 * Lightweight current-user probe — does NOT prompt for sign-in.
 *
 * Used to flip the landing page into its personalized panel for
 * authenticated visitors without forcing the Authenticator modal
 * onto guests.
 *
 * Backed by the root {@link useAuth} context (#720): identity is fetched
 * once per session and served synchronously here, so consumers no longer
 * re-probe Cognito (and flash) on every navigation. The hook surface is
 * unchanged for back-compat with existing callers.
 */
export function useSessionState(): SessionState {
  const { loading, signedIn, username, sub } = useAuth();
  return { loading, signedIn, username, sub };
}
