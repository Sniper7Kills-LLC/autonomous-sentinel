'use client';

import { useState } from 'react';
import { signInWithRedirect } from 'aws-amplify/auth';
import { Button } from '@/components/ui/Button';
import styles from './FederatedButtons.module.css';

type FederatedProvider = 'Google' | 'Discord';

/**
 * Google + Discord federated sign-in buttons (#336).
 *
 * Shared across every login surface (the standalone sign-in panel + every
 * Amplify `Authenticator` gate, injected via `AppAuthenticator`). Google is a
 * built-in Cognito social provider; Discord is the custom OIDC IdP (the
 * in-house bridge, registered as "Discord") — the Amplify Authenticator can't
 * render a custom-OIDC button itself, which is why we supply our own.
 */
export function FederatedButtons() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<FederatedProvider | null>(null);

  const start = async (provider: FederatedProvider) => {
    setError(null);
    setBusy(provider);
    try {
      await signInWithRedirect(
        provider === 'Google' ? { provider: 'Google' } : { provider: { custom: 'Discord' } },
      );
      // Default flow does a full-page redirect, so this rarely runs.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start federated sign-in. Try again.');
      setBusy(null);
    }
  };

  return (
    <div className={styles.wrap}>
      <Button
        variant="secondary"
        disabled={busy !== null}
        loading={busy === 'Google'}
        onClick={() => void start('Google')}
        data-testid="signin-google"
      >
        Continue with Google
      </Button>
      <Button
        variant="secondary"
        disabled={busy !== null}
        loading={busy === 'Discord'}
        onClick={() => void start('Discord')}
        data-testid="signin-discord"
      >
        Continue with Discord
      </Button>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.divider}>
        <span>or use email</span>
      </div>
    </div>
  );
}
