'use client';

import { Authenticator, ThemeProvider, createTheme } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import type { ComponentProps } from 'react';
import { FederatedButtons } from './FederatedButtons';

/**
 * App-wide Amplify Authenticator (#336 / theming).
 *
 * Wraps `<Authenticator>` so every login surface (sign-in panel + all gated
 * routes) is consistent:
 *   - themed to the command aesthetic via an Amplify-UI `createTheme` mapped to
 *     the app's CSS custom properties (so it tracks light/dark automatically);
 *   - the built-in social buttons hidden (`socialProviders={[]}`) in favour of
 *     our own Google + Discord buttons (the Authenticator can't render the
 *     custom-OIDC Discord provider), injected into both the Sign In + Create
 *     Account tab headers.
 *
 * All props (incl. the render-prop `children`) pass straight through, so this
 * is a drop-in replacement for `<Authenticator>`.
 */

const theme = createTheme({
  name: 'sentinel-auth',
  tokens: {
    fonts: {
      default: {
        variable: { value: 'var(--font-jb-mono)' },
        static: { value: 'var(--font-jb-mono)' },
      },
    },
    colors: {
      background: {
        primary: { value: 'var(--surface-1)' },
        secondary: { value: 'var(--surface-2)' },
      },
      font: {
        primary: { value: 'var(--text-1)' },
        secondary: { value: 'var(--text-2)' },
        interactive: { value: 'var(--color-accent)' },
      },
      border: {
        primary: { value: 'var(--border-1)' },
        secondary: { value: 'var(--border-1)' },
      },
      brand: {
        primary: {
          10: { value: 'var(--surface-2)' },
          80: { value: 'var(--color-accent)' },
          90: { value: 'var(--color-accent)' },
          100: { value: 'var(--color-accent)' },
        },
      },
    },
    radii: {
      small: { value: 'var(--radius-sm)' },
      medium: { value: 'var(--radius-md)' },
    },
    components: {
      authenticator: {
        router: {
          backgroundColor: { value: 'var(--surface-1)' },
          borderColor: { value: 'var(--border-1)' },
        },
      },
      tabs: {
        item: {
          color: { value: 'var(--text-2)' },
          _active: {
            color: { value: 'var(--color-accent)' },
            borderColor: { value: 'var(--color-accent)' },
          },
        },
      },
      fieldcontrol: {
        color: { value: 'var(--text-1)' },
        borderColor: { value: 'var(--border-1)' },
      },
    },
  },
});

const federatedComponents = {
  SignIn: { Header: FederatedButtons },
  SignUp: { Header: FederatedButtons },
};

export function AppAuthenticator(props: ComponentProps<typeof Authenticator>) {
  return (
    <ThemeProvider theme={theme}>
      <Authenticator socialProviders={[]} components={federatedComponents} {...props} />
    </ThemeProvider>
  );
}
