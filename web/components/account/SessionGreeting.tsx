'use client';

import { useEffect, useState } from 'react';
import { configureAmplifyOnce } from '@/lib/amplifyClient';

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
 */
export function useSessionState(): SessionState {
  const [state, setState] = useState<SessionState>({
    loading: true,
    signedIn: false,
    username: null,
    sub: null,
  });

  useEffect(() => {
    let cancelled = false;
    configureAmplifyOnce();
    void (async () => {
      try {
        const { getCurrentUser, fetchAuthSession } = await import('aws-amplify/auth');
        const user = await getCurrentUser();
        const session = await fetchAuthSession();
        const idClaims = session.tokens?.idToken?.payload;
        const sub =
          (typeof idClaims?.sub === 'string' ? idClaims.sub : null) ?? user?.userId ?? null;
        if (cancelled) return;
        setState({
          loading: false,
          signedIn: true,
          username: user?.signInDetails?.loginId ?? user?.username ?? null,
          sub,
        });
      } catch {
        if (cancelled) return;
        setState({ loading: false, signedIn: false, username: null, sub: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
