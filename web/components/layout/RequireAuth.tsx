'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSessionState } from '@/components/account/SessionGreeting';
import styles from './SiteChrome.module.css';

/**
 * Client-side auth gate for the `(account)` route group (#71).
 *
 * Amplify auth is resolved client-side (Cognito tokens in browser
 * storage, not cookies), so the redirect is enforced in the layout
 * rather than in Next middleware. Logged-out visitors are bounced to
 * `/sign-in?next=<path>` so they return to their destination after
 * signing in. The server still authorizes every read/mutation.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, signedIn } = useSessionState();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !signedIn) {
      const next = encodeURIComponent(pathname || '/');
      router.replace(`/sign-in?next=${next}`);
    }
  }, [loading, signedIn, pathname, router]);

  if (loading) {
    return (
      <p className={styles.gateNotice} role="status">
        Checking your session…
      </p>
    );
  }

  if (!signedIn) {
    return (
      <p className={styles.gateNotice} role="status">
        Redirecting to sign-in…
      </p>
    );
  }

  return <>{children}</>;
}
