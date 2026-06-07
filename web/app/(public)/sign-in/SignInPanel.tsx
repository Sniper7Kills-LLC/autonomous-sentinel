'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { AppAuthenticator } from '@/components/auth/AppAuthenticator';
import styles from './SignInPanel.module.css';

/**
 * Standalone sign-in panel (#336).
 *
 * Delegates to the shared `AppAuthenticator`, which is themed to the command
 * aesthetic and injects the Google + Discord federated buttons into both the
 * Sign In and Create Account tabs. The render-prop body shows the signed-in
 * quick links once authenticated.
 */
export function SignInPanel() {
  return (
    <div className={styles.shell}>
      <AppAuthenticator>
        {({ signOut, user }) => (
          <div className={styles.signedIn}>
            <p className={styles.signedInLine}>
              Signed in as <code>{user?.signInDetails?.loginId ?? user?.username}</code>
            </p>
            <Link href="/portal">Open testing portal →</Link>
            <Link href="/submit">Submit a recording-less message →</Link>
            <Link href="/">Return to dashboard →</Link>
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        )}
      </AppAuthenticator>
    </div>
  );
}
