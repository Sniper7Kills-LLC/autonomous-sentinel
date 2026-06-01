import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SupportTiers } from './SupportTiers';

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

const createSubscriptionCheckoutMock = vi.fn<(input: unknown) => Promise<unknown>>();
vi.mock('@/lib/donations/checkout', () => ({
  createSubscriptionCheckout: (input: unknown) => createSubscriptionCheckoutMock(input),
}));

describe('SupportTiers', () => {
  beforeEach(() => {
    sessionState = { loading: false, signedIn: false, username: null, sub: null };
    bannedState = { banned: false, resolved: true };
    createSubscriptionCheckoutMock.mockReset();
    createSubscriptionCheckoutMock.mockResolvedValue({
      enabled: false,
      status: 'test-mode',
      message: 'Payments are not yet enabled (test mode).',
    });
  });

  it('renders all three tiers with their monthly prices', () => {
    render(<SupportTiers />);
    expect(screen.getByText('Tier 1')).toBeInTheDocument();
    expect(screen.getByText('Tier 2')).toBeInTheDocument();
    expect(screen.getByText('Tier 3')).toBeInTheDocument();
    expect(screen.getByText('$3.00')).toBeInTheDocument();
    expect(screen.getByText('$7.00')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
  });

  it('shows sign-in CTAs for guests (no subscribe call possible)', () => {
    render(<SupportTiers />);
    expect(screen.getAllByRole('button', { name: /sign in to subscribe/i })).toHaveLength(3);
  });

  it('reprices to the covered amount when the fee toggle is on', () => {
    render(<SupportTiers />);
    fireEvent.click(screen.getByLabelText(/cover the stripe fee/i));
    // Tier 1 covered: (3 + 0.30)/0.971 = 3.40
    expect(screen.getByText('$3.40')).toBeInTheDocument();
  });

  it('lets a signed-in user start subscription checkout (stub)', async () => {
    sessionState = { loading: false, signedIn: true, username: 'op', sub: 'sub-9' };
    render(<SupportTiers />);
    fireEvent.click(screen.getByRole('button', { name: /subscribe to tier 2/i }));
    await waitFor(() => expect(createSubscriptionCheckoutMock).toHaveBeenCalledTimes(1));
    expect(createSubscriptionCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({ tierId: 'tier2', userId: 'sub-9' }),
    );
    expect(await screen.findByText(/not yet enabled/i)).toBeInTheDocument();
  });

  it('toggles the comparison table', () => {
    render(<SupportTiers />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show feature comparison/i }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /discord webhook relays/i })).toBeInTheDocument();
  });

  it('blocks subscribe CTAs for a banned signed-in account', () => {
    sessionState = { loading: false, signedIn: true, username: 'op', sub: 'sub-9' };
    bannedState = { banned: true, resolved: true };
    render(<SupportTiers />);
    expect(screen.getByText(/subscriptions are unavailable for your account/i)).toBeInTheDocument();
    for (const btn of screen.getAllByRole('button', { name: /subscribe to tier/i })) {
      expect(btn).toBeDisabled();
    }
  });
});
