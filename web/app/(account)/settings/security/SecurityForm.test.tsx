import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SecurityForm } from './SecurityForm';

const updatePassword =
  vi.fn<(input: { oldPassword: string; newPassword: string }) => Promise<void>>();
const setUpTOTP =
  vi.fn<() => Promise<{ sharedSecret: string; getSetupUri: (appName: string) => URL }>>();
const verifyTOTPSetup = vi.fn<(input: { code: string }) => Promise<void>>();
const updateMFAPreference = vi.fn<(input: { totp: string }) => Promise<void>>();
const fetchMFAPreference = vi.fn<() => Promise<{ enabled?: string[] }>>();

vi.mock('aws-amplify/auth', () => ({
  updatePassword: (input: { oldPassword: string; newPassword: string }) => updatePassword(input),
  setUpTOTP: () => setUpTOTP(),
  verifyTOTPSetup: (input: { code: string }) => verifyTOTPSetup(input),
  updateMFAPreference: (input: { totp: string }) => updateMFAPreference(input),
  fetchMFAPreference: () => fetchMFAPreference(),
}));

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({
    loading: false,
    signedIn: true,
    username: 'pilot@example.com',
    sub: 'sub-1',
    groups: [],
  }),
}));

function typeInto(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/**
 * Render and wait for the mount-time `fetchMFAPreference()` dynamic import
 * to resolve before interacting. The component lazy-imports
 * `aws-amplify/auth` (`await import(...)`); the first resolution caches the
 * mocked module in the graph. Interacting before that first import settles
 * can race the mock registration, so every test settles the mount first.
 */
async function renderSettled() {
  render(<SecurityForm />);
  await waitFor(() => expect(fetchMFAPreference).toHaveBeenCalled());
}

describe('SecurityForm', () => {
  beforeEach(() => {
    updatePassword.mockReset().mockResolvedValue(undefined);
    setUpTOTP.mockReset();
    verifyTOTPSetup.mockReset().mockResolvedValue(undefined);
    updateMFAPreference.mockReset().mockResolvedValue(undefined);
    fetchMFAPreference.mockReset().mockResolvedValue({ enabled: [] });
  });

  it('calls updatePassword with the old + new password on submit', async () => {
    await renderSettled();
    typeInto(/current password/i, 'oldpass123');
    typeInto(/^new password/i, 'newpass456');
    typeInto(/confirm new password/i, 'newpass456');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    await waitFor(() =>
      expect(updatePassword).toHaveBeenCalledWith({
        oldPassword: 'oldpass123',
        newPassword: 'newpass456',
      }),
    );
    expect(await screen.findByText(/password updated/i)).toBeInTheDocument();
  });

  it('shows an error and does not call updatePassword when confirmation mismatches', async () => {
    await renderSettled();
    typeInto(/current password/i, 'oldpass123');
    typeInto(/^new password/i, 'newpass456');
    typeInto(/confirm new password/i, 'different999');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('rejects a too-short new password without calling updatePassword', async () => {
    await renderSettled();
    typeInto(/current password/i, 'oldpass123');
    typeInto(/^new password/i, 'short');
    typeInto(/confirm new password/i, 'short');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('reads MFA preference on mount and shows Disabled when TOTP is off', async () => {
    await renderSettled();
    await waitFor(() => expect(fetchMFAPreference).toHaveBeenCalled());
    expect(await screen.findByText(/disabled/i)).toBeInTheDocument();
  });

  it('runs the enable flow: setUpTOTP then verifyTOTPSetup + updateMFAPreference', async () => {
    setUpTOTP.mockResolvedValue({
      sharedSecret: 'ABCDEF234567',
      getSetupUri: () => new URL('otpauth://totp/Autonomous%20Sentinel?secret=ABCDEF234567'),
    });
    await renderSettled();

    fireEvent.click(await screen.findByRole('button', { name: /enable two-factor/i }));

    await waitFor(() => expect(setUpTOTP).toHaveBeenCalled());
    expect(await screen.findByText('ABCDEF234567')).toBeInTheDocument();

    typeInto(/6-digit code/i, '123456');
    fireEvent.click(screen.getByRole('button', { name: /verify and enable/i }));

    await waitFor(() => expect(verifyTOTPSetup).toHaveBeenCalledWith({ code: '123456' }));
    expect(updateMFAPreference).toHaveBeenCalledWith({ totp: 'PREFERRED' });
    expect(await screen.findByText(/now enabled/i)).toBeInTheDocument();
  });

  it('disables TOTP via updateMFAPreference when already enabled', async () => {
    fetchMFAPreference.mockResolvedValue({ enabled: ['TOTP'] });
    await renderSettled();

    const disableBtn = await screen.findByRole('button', { name: /disable two-factor/i });
    fireEvent.click(disableBtn);

    await waitFor(() => expect(updateMFAPreference).toHaveBeenCalledWith({ totp: 'DISABLED' }));
    expect(await screen.findByText(/has been disabled/i)).toBeInTheDocument();
  });
});
