'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { configureAmplifyOnce } from '@/lib/amplifyClient';

/**
 * Resolved caller identity, fetched once per browser session and held
 * in React context. Drives every client-side render decision keyed off
 * the signed-in user: the personalized landing panel, role-gated nav
 * (Admin link / admin console), and the `(account)` route gate.
 *
 * `groups` is the idToken's `cognito:groups` claim. The server enforces
 * the same authorization on every read/mutation — context only decides
 * what to render, never what is allowed.
 */
export interface AuthState {
  loading: boolean;
  signedIn: boolean;
  username: string | null;
  /** Cognito user sub (UUID) — the `User.id = cognitoSub` key behind
   *  `Recording.uploaderId`, `Reputation.userId`, etc. */
  sub: string | null;
  groups: string[];
}

const LOADING_STATE: AuthState = {
  loading: true,
  signedIn: false,
  username: null,
  sub: null,
  groups: [],
};

const SIGNED_OUT_STATE: AuthState = {
  loading: false,
  signedIn: false,
  username: null,
  sub: null,
  groups: [],
};

const AuthContext = createContext<AuthState>(LOADING_STATE);

/**
 * Single source of truth for client-side auth state (#720).
 *
 * Mounted once at the root layout — above every route group — so it is
 * never remounted on client-side navigation. Before this provider each
 * consumer (header, account gate, landing panel, every role-gated
 * control) ran its own `useEffect` probe of Cognito on mount; crossing
 * route groups remounted the chrome and re-ran every probe, producing a
 * visible "re-checking who you are" flash. Resolving identity once and
 * serving it from context makes subsequent mounts synchronous.
 *
 * A `Hub.listen('auth', …)` subscription keeps the cached state live:
 * sign-in / sign-out / token-refresh update the context without a
 * remount, so the header reflects auth changes immediately.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(LOADING_STATE);

  useEffect(() => {
    let cancelled = false;
    configureAmplifyOnce();

    const load = async () => {
      try {
        const { getCurrentUser, fetchAuthSession } = await import('aws-amplify/auth');
        const user = await getCurrentUser();
        const session = await fetchAuthSession();
        const claims = session.tokens?.idToken?.payload;
        const sub = (typeof claims?.sub === 'string' ? claims.sub : null) ?? user?.userId ?? null;
        const rawGroups = claims?.['cognito:groups'];
        const groups = Array.isArray(rawGroups)
          ? rawGroups.filter((g): g is string => typeof g === 'string')
          : [];
        if (cancelled) return;
        setState({
          loading: false,
          signedIn: true,
          username: user?.signInDetails?.loginId ?? user?.username ?? null,
          sub,
          groups,
        });
      } catch {
        if (cancelled) return;
        setState(SIGNED_OUT_STATE);
      }
    };

    void load();

    let unsubscribe = () => {};
    void (async () => {
      const { Hub } = await import('aws-amplify/utils');
      const stop = Hub.listen('auth', ({ payload }) => {
        if (cancelled) return;
        switch (payload.event) {
          case 'signedIn':
          case 'tokenRefresh':
            void load();
            break;
          case 'signedOut':
            setState(SIGNED_OUT_STATE);
            // Drop the session-scoped stats cache so the next visitor
            // re-fetches rather than seeing the prior session's payload.
            void import('@/components/charts/StatsLoader').then((m) => m.clearStatsCache());
            // Reset the cached AppSync auth mode so post-sign-out data
            // calls fall back to the guest (identityPool) path instead of
            // re-using the userPool mode resolved for the signed-in session.
            void import('@/lib/auth/mode').then((m) => m.clearAuthModeCache());
            break;
          default:
            break;
        }
      });
      // The component may have unmounted while the dynamic import was in
      // flight; tear the listener down immediately if so.
      if (cancelled) stop();
      else unsubscribe = stop;
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return <AuthContext value={state}>{children}</AuthContext>;
}

/** Full resolved auth state from context. */
export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/**
 * Caller Cognito groups + loading flag from context. Replaces the
 * per-component `fetchCallerGroups()` `useEffect` in role-gated chrome
 * so the Admin nav / admin console no longer re-probe Cognito (and
 * flash) on every navigation.
 */
export function useCallerGroups(): { groups: string[]; loading: boolean } {
  const { groups, loading } = useContext(AuthContext);
  return { groups, loading };
}
