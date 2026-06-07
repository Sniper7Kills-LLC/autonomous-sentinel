import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SignInPanel } from './SignInPanel';

const signInWithRedirect = vi.fn<(input: unknown) => Promise<void>>();
vi.mock('aws-amplify/auth', () => ({
  signInWithRedirect: (input: unknown) => signInWithRedirect(input),
}));

// The Amplify Authenticator renders its render-prop children; stub it so the
// test focuses on the federated buttons (the #336 surface).
vi.mock('@aws-amplify/ui-react', () => ({
  Authenticator: ({
    children,
  }: {
    children: (ctx: { signOut: () => void; user: unknown }) => React.ReactNode;
  }) => children({ signOut: () => {}, user: { username: 'tester' } }),
}));

describe('SignInPanel federated buttons (#336)', () => {
  beforeEach(() => {
    signInWithRedirect.mockReset();
    signInWithRedirect.mockResolvedValue(undefined);
  });

  it('starts Google federation with the built-in provider', async () => {
    render(<SignInPanel />);
    fireEvent.click(screen.getByTestId('signin-google'));
    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledWith({ provider: 'Google' }));
  });

  it('starts Discord federation with the custom OIDC provider', async () => {
    render(<SignInPanel />);
    fireEvent.click(screen.getByTestId('signin-discord'));
    await waitFor(() =>
      expect(signInWithRedirect).toHaveBeenCalledWith({ provider: { custom: 'Discord' } }),
    );
  });

  it('surfaces an error and re-enables the buttons when starting federation fails', async () => {
    signInWithRedirect.mockRejectedValue(new Error('popup blocked'));
    render(<SignInPanel />);
    fireEvent.click(screen.getByTestId('signin-discord'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/popup blocked/i));
    // busy resets on failure so the user can retry (not stuck disabled).
    expect(screen.getByTestId('signin-discord')).not.toBeDisabled();
    expect(screen.getByTestId('signin-google')).not.toBeDisabled();
  });
});
