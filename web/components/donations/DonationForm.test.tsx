import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DonationForm } from './DonationForm';

let sessionState = {
  loading: false,
  signedIn: false,
  username: null as string | null,
  sub: null as string | null,
};
vi.mock('@/components/account/SessionGreeting', () => ({
  useSessionState: () => sessionState,
}));

let bannedState = { banned: false, resolved: true };
vi.mock('@/lib/donations/useBannedGate', () => ({
  useBannedGate: () => bannedState,
}));

const createDonationCheckoutMock = vi.fn<(input: unknown) => Promise<unknown>>();
vi.mock('@/lib/donations/checkout', () => ({
  createDonationCheckout: (input: unknown) => createDonationCheckoutMock(input),
}));

describe('DonationForm', () => {
  beforeEach(() => {
    sessionState = { loading: false, signedIn: false, username: null, sub: null };
    bannedState = { banned: false, resolved: true };
    createDonationCheckoutMock.mockReset();
    createDonationCheckoutMock.mockResolvedValue({
      enabled: false,
      status: 'test-mode',
      message: 'Payments are not yet enabled (test mode).',
    });
  });

  it('defaults the CTA to the $10 preset', () => {
    render(<DonationForm />);
    expect(screen.getByRole('button', { name: /donate \$10\.00/i })).toBeInTheDocument();
  });

  it('reflects a preset selection in the CTA amount', () => {
    render(<DonationForm />);
    fireEvent.click(screen.getByRole('button', { name: '$25' }));
    expect(screen.getByRole('button', { name: /donate \$25\.00/i })).toBeInTheDocument();
  });

  it('validates a custom amount below the minimum', () => {
    render(<DonationForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const input = screen.getByLabelText(/custom amount/i);
    fireEvent.change(input, { target: { value: '0.50' } });
    fireEvent.blur(input);
    // Shown both as the field error and the CTA hint.
    expect(screen.getAllByText(/minimum donation is \$1/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /donate/i })).toBeDisabled();
  });

  it('calls the stub with the covered amount + guest payload and shows the test-mode notice', async () => {
    render(<DonationForm />);
    // cover the fee
    fireEvent.click(screen.getByLabelText(/cover the stripe fee/i));
    fireEvent.click(screen.getByRole('button', { name: /donate/i }));

    await waitFor(() => expect(createDonationCheckoutMock).toHaveBeenCalledTimes(1));
    expect(createDonationCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intendedAmount: 10,
        coverFee: true,
        wantsBadge: false, // guest → badge skipped
        userId: null,
      }),
    );
    expect(await screen.findByText(/payments not yet enabled \(test mode\)/i)).toBeInTheDocument();
  });

  it('attaches userId + badge for a signed-in donor', async () => {
    sessionState = { loading: false, signedIn: true, username: 'op', sub: 'sub-9' };
    render(<DonationForm />);
    fireEvent.click(screen.getByRole('button', { name: /donate/i }));
    await waitFor(() => expect(createDonationCheckoutMock).toHaveBeenCalledTimes(1));
    expect(createDonationCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'sub-9', wantsBadge: true }),
    );
  });

  it('blocks the form for a banned account', () => {
    bannedState = { banned: true, resolved: true };
    render(<DonationForm />);
    expect(screen.getByText(/donations are unavailable for your account/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /donate/i })).not.toBeInTheDocument();
  });
});
