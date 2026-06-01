'use client';

import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import styles from './SignInPanel.module.css';

export function SignInPanel() {
  return (
    <div className={styles.shell}>
      <p className={styles.note}>
        Sign in with email + password. Federated sign-in (Google / Discord) is tracked under issue
        #336 and will land in a follow-up — the Discord OIDC bridge wiring is the blocker, not the
        button styling.
      </p>
      <Authenticator
        // Hide the federated provider buttons that would otherwise render
        // alongside email/password at the top of the sign-in form.
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
      <p className={styles.federatedDefer}>Federated providers · deferred to #336</p>
    </div>
  );
}
