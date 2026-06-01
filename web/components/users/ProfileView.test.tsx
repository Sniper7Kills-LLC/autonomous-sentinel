import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ProfileView } from './ProfileView';
import type { DisplayProfile } from '@/lib/users/profile';

const getProfileMock = vi.fn<(id: string) => Promise<DisplayProfile | null>>();
vi.mock('@/lib/users/profile', () => ({
  getProfile: (id: string) => getProfileMock(id),
}));

let sessionState = {
  loading: false,
  signedIn: false,
  username: null as string | null,
  sub: null as string | null,
};
vi.mock('@/components/account/SessionGreeting', () => ({
  useSessionState: () => sessionState,
}));

function profile(partial: Partial<DisplayProfile>): DisplayProfile {
  return {
    id: 'sub-1',
    displayName: 'Spectre',
    handle: 'spectre',
    role: 'member',
    joinedAt: '2026-01-01T00:00:00Z',
    piiBlanked: false,
    reputation: { computedWeight: 2, validatedSubmissions: 7, acceptedCorrections: 3 },
    ...partial,
  };
}

describe('ProfileView', () => {
  beforeEach(() => {
    getProfileMock.mockReset();
    sessionState = { loading: false, signedIn: false, username: null, sub: null };
  });

  it('renders name, role badge, and reputation stats', async () => {
    getProfileMock.mockResolvedValue(profile({}));
    render(<ProfileView id="sub-1" />);
    expect(await screen.findByText('Spectre')).toBeInTheDocument();
    expect(screen.getByText('MEMBER')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2.0×')).toBeInTheDocument();
  });

  it('shows an admin role badge', async () => {
    getProfileMock.mockResolvedValue(profile({ role: 'admin' }));
    render(<ProfileView id="sub-1" />);
    expect(await screen.findByText('ADMIN')).toBeInTheDocument();
  });

  it('renders the deactivated empty state for a PII-blanked user', async () => {
    getProfileMock.mockResolvedValue(
      profile({ piiBlanked: true, displayName: null, handle: null }),
    );
    render(<ProfileView id="sub-1" />);
    expect(await screen.findByText(/account has been deactivated/i)).toBeInTheDocument();
    expect(screen.queryByText('Contribution stats')).not.toBeInTheDocument();
  });

  it('shows "not found" when no profile resolves', async () => {
    getProfileMock.mockResolvedValue(null);
    render(<ProfileView id="missing" />);
    expect(await screen.findByText(/no operator found/i)).toBeInTheDocument();
  });

  it('shows self-actions only for the signed-in owner', async () => {
    sessionState = { loading: false, signedIn: true, username: 'me', sub: 'sub-1' };
    getProfileMock.mockResolvedValue(profile({}));
    render(<ProfileView id="sub-1" />);
    expect(await screen.findByText('Delete account')).toBeInTheDocument();
    expect(screen.getByText('YOU')).toBeInTheDocument();
  });

  it('hides self-actions for a different viewer', async () => {
    sessionState = { loading: false, signedIn: true, username: 'me', sub: 'sub-OTHER' };
    getProfileMock.mockResolvedValue(profile({}));
    render(<ProfileView id="sub-1" />);
    await screen.findByText('Spectre');
    expect(screen.queryByText('Delete account')).not.toBeInTheDocument();
    expect(screen.queryByText('YOU')).not.toBeInTheDocument();
  });

  it('shows a no-contributions note when reputation is null', async () => {
    getProfileMock.mockResolvedValue(profile({ reputation: null }));
    render(<ProfileView id="sub-1" />);
    expect(await screen.findByText(/no contributions recorded yet/i)).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    getProfileMock.mockRejectedValue(new Error('boom'));
    render(<ProfileView id="sub-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/));
  });
});
