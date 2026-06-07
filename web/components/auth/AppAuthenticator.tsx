'use client';

import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import type { ComponentProps } from 'react';
import { FederatedButtons } from './FederatedButtons';
import styles from './AppAuthenticator.module.css';

/**
 * App-wide Amplify Authenticator (#336).
 *
 * One themed, federated login surface reused everywhere (sign-in panel + the
 * /portal and /submit gates):
 *   - re-skinned to the site's command-terminal aesthetic via `--amplify-*`
 *     custom properties set on the framing panel (see the CSS module), so it
 *     tracks light/dark automatically through the shared tokens;
 *   - the built-in social buttons hidden (`socialProviders={[]}`) in favour of
 *     our own Google + Discord buttons (the Authenticator can't render the
 *     custom-OIDC Discord provider), injected into both the Sign In + Create
 *     Account tab headers.
 *
 * All props (incl. the render-prop `children`) pass straight through, so this
 * is a drop-in replacement for `<Authenticator>`.
 */

const federatedComponents = {
  SignIn: { Header: FederatedButtons },
  SignUp: { Header: FederatedButtons },
};

export function AppAuthenticator(props: ComponentProps<typeof Authenticator>) {
  return (
    <div className={styles.frame}>
      <div className={styles.eyebrow}>
        <span>secure access</span>
      </div>
      <Authenticator socialProviders={[]} components={federatedComponents} {...props} />
    </div>
  );
}
