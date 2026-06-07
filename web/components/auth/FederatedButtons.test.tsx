import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FederatedButtons } from './FederatedButtons';

const signInWithRedirect = vi.fn<(input: unknown) => Promise<void>>();
vi.mock('aws-amplify/auth', () => ({
  signInWithRedirect: (input: unknown) => signInWithRedirect(input),
}));

describe('FederatedButtons (#336)', () => {
  beforeEach(() => {
    signInWithRedirect.mockReset();
    signInWithRedirect.mockResolvedValue(undefined);
  });

  it('starts Google federation with the built-in provider', async () => {
    render(<FederatedButtons />);
    fireEvent.click(screen.getByTestId('signin-google'));
    await waitFor(() => expect(signInWithRedirect).toHaveBeenCalledWith({ provider: 'Google' }));
  });

  it('starts Discord federation with the custom OIDC provider', async () => {
    render(<FederatedButtons />);
    fireEvent.click(screen.getByTestId('signin-discord'));
    await waitFor(() =>
      expect(signInWithRedirect).toHaveBeenCalledWith({ provider: { custom: 'Discord' } }),
    );
  });

  it('surfaces an error and re-enables the buttons when starting fails', async () => {
    signInWithRedirect.mockRejectedValue(new Error('popup blocked'));
    render(<FederatedButtons />);
    fireEvent.click(screen.getByTestId('signin-discord'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/popup blocked/i));
    expect(screen.getByTestId('signin-discord')).not.toBeDisabled();
    expect(screen.getByTestId('signin-google')).not.toBeDisabled();
  });
});
