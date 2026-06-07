import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppAuthenticator } from './AppAuthenticator';

// Stub the Amplify Authenticator: render the injected SignIn header (where the
// federated buttons live) + invoke the render-prop children, so the test can
// assert the wrapper wires both.
vi.mock('@aws-amplify/ui-react', () => ({
  createTheme: () => ({ name: 'stub' }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Authenticator: (props: {
    components?: { SignIn?: { Header?: () => React.ReactNode } };
    children?: (ctx: { signOut: () => void; user: unknown }) => React.ReactNode;
  }) => (
    <div>
      {props.components?.SignIn?.Header?.()}
      {props.children?.({ signOut: () => {}, user: { username: 'tester' } })}
    </div>
  ),
}));

vi.mock('aws-amplify/auth', () => ({ signInWithRedirect: vi.fn() }));

describe('AppAuthenticator (#336)', () => {
  it('injects the Google + Discord federated buttons into the Sign In header', () => {
    render(<AppAuthenticator>{() => <div>signed-in body</div>}</AppAuthenticator>);
    expect(screen.getByTestId('signin-google')).toBeInTheDocument();
    expect(screen.getByTestId('signin-discord')).toBeInTheDocument();
  });

  it('passes the render-prop children through', () => {
    render(<AppAuthenticator>{() => <div>signed-in body</div>}</AppAuthenticator>);
    expect(screen.getByText('signed-in body')).toBeInTheDocument();
  });
});
