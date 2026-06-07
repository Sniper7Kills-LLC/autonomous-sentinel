'use client';

import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { useState } from 'react';
import Link from 'next/link';
import { signInWithRedirect } from 'aws-amplify/auth';
import { Button } from '@/components/ui/Button';
import styles from './SignInPanel.module.css';

type FederatedProvider = 'Google' | 'Discord';

export function SignInPanel() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<FederatedProvider | null>(null);

  const startFederated = async (provider: FederatedProvider) => {
    setError(null);
    setBusy(provider);
    try {
      // Google is a built-in Cognito social provider; Discord is our custom
      // OIDC IdP (the in-house bridge, registered under the name "Discord").
      await signInWithRedirect(
        provider === 'Google' ? { provider: 'Google' } : { provider: { custom: 'Discord' } },
      );
      // On success the browser navigates to the IdP, so this rarely runs.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start federated sign-in. Try again.');
      setBusy(null);
    }
  };

  return (
    <div className={styles.shell}>
      <div className={styles.federated}>
        <Button
          variant="secondary"
          disabled={busy !== null}
          loading={busy === 'Google'}
          onClick={() => void startFederated('Google')}
          data-testid="signin-google"
        >
          Continue with Google
        </Button>
        <Button
          variant="secondary"
          disabled={busy !== null}
          loading={busy === 'Discord'}
          onClick={() => void startFederated('Discord')}
          data-testid="signin-discord"
        >
          Continue with Discord
        </Button>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>

      <div className={styles.divider}>
        <span>or sign in with email</span>
      </div>

      <Authenticator
        // Hide the Authenticator's own federated buttons — we render styled
        // ones above so the layout matches the command aesthetic (#336).
        socialProviders={[]}
      >
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
      </Authenticator>
    </div>
  );
}
