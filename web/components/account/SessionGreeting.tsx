'use client';

import { useEffect, useState } from 'react';
import { configureAmplifyOnce } from '@/lib/amplifyClient';

interface SessionState {
  loading: boolean;
  signedIn: boolean;
  username: string | null;
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
  });

  useEffect(() => {
    let cancelled = false;
    configureAmplifyOnce();
    void (async () => {
      try {
        const { getCurrentUser } = await import('aws-amplify/auth');
        const user = await getCurrentUser();
        if (cancelled) return;
        setState({
          loading: false,
          signedIn: true,
          username: user?.signInDetails?.loginId ?? user?.username ?? null,
        });
      } catch {
        if (cancelled) return;
        setState({ loading: false, signedIn: false, username: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
