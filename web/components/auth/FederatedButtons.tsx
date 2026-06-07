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
        <span className={styles.btn}>
          <GoogleIcon />
          Continue with Google
        </span>
      </Button>
      <Button
        variant="secondary"
        disabled={busy !== null}
        loading={busy === 'Discord'}
        onClick={() => void start('Discord')}
        data-testid="signin-discord"
      >
        <span className={styles.btn}>
          <DiscordIcon />
          Continue with Discord
        </span>
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

/** Official 4-colour Google "G". */
function GoogleIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001 6.19 5.238 6.19 5.238.438.398 6.394-4.661 6.394-13.809 0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

/** Official Discord mark in brand blurple. */
function DiscordIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#5865F2"
        d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.21.375-.444.88-.608 1.283a18.27 18.27 0 0 0-5.487 0A12.6 12.6 0 0 0 9.85 3 19.74 19.74 0 0 0 6.09 4.369C2.72 9.39 1.81 14.28 2.27 19.1a19.9 19.9 0 0 0 6.073 3.058c.49-.668.927-1.378 1.304-2.124a12.9 12.9 0 0 1-2.053-.984c.172-.127.34-.26.502-.397 3.96 1.853 8.24 1.853 12.152 0 .164.137.332.27.502.397-.656.388-1.345.717-2.056.985.377.746.814 1.456 1.304 2.124a19.86 19.86 0 0 0 6.075-3.058c.546-5.586-.934-10.432-3.926-14.731ZM8.02 16.166c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.42 2.157-2.42 1.21 0 2.176 1.096 2.157 2.42 0 1.334-.955 2.419-2.157 2.419Zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.42 2.157-2.42 1.21 0 2.176 1.096 2.157 2.42 0 1.334-.946 2.419-2.157 2.419Z"
      />
    </svg>
  );
}
