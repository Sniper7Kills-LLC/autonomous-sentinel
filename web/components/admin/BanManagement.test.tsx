import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BanManagement } from './BanManagement';
import type { BannedUser } from '@/lib/admin/bans';

const listMock = vi.fn<() => Promise<BannedUser[]>>();
const findMock = vi.fn<(email: string) => Promise<string | null>>();
const banMock = vi.fn<(sub: string, reason: string) => Promise<void>>();
const unbanMock = vi.fn<(sub: string, reason: string) => Promise<void>>();

vi.mock('@/lib/admin/bans', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    listBannedUsers: () => listMock(),
    findUserSubByEmail: (e: string) => findMock(e),
    banUserBySub: (s: string, r: string) => banMock(s, r),
    unbanUserBySub: (s: string, r: string) => unbanMock(s, r),
  };
});

function row(p: Partial<BannedUser>): BannedUser {
  return {
    cognitoSub: 'sub-1',
    email: 'bad@actor.test',
    displayName: 'Bad Actor',
    bannedAt: '2026-06-01T00:00:00.000Z',
    bannedReason: 'spam',
    bannedById: 'admin-1',
    ...p,
  };
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([row({})]);
  findMock.mockReset().mockResolvedValue('sub-2');
  banMock.mockReset().mockResolvedValue();
  unbanMock.mockReset().mockResolvedValue();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('BanManagement (#112)', () => {
  it('lists currently-banned users on the Users tab', async () => {
    render(<BanManagement />);
    await waitFor(() => expect(screen.getByText('bad@actor.test')).toBeInTheDocument());
    expect(screen.getByText('spam')).toBeInTheDocument();
    expect(screen.getByText(/1 banned user/)).toBeInTheDocument();
  });

  it('bans a user by email (lookup → banUser) and reloads', async () => {
    render(<BanManagement />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('User email to ban'), {
      target: { value: 'new@target.test' },
    });
    fireEvent.change(screen.getByLabelText('Ban reason'), { target: { value: 'abuse' } });
    fireEvent.click(screen.getByRole('button', { name: /^ban$/i }));
    await waitFor(() => {
      expect(findMock).toHaveBeenCalledWith('new@target.test');
      expect(banMock).toHaveBeenCalledWith('sub-2', 'abuse');
    });
  });

  it('errors when the email resolves to no user', async () => {
    findMock.mockResolvedValue(null);
    render(<BanManagement />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('User email to ban'), {
      target: { value: 'ghost@nowhere.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^ban$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no user found/i);
    expect(banMock).not.toHaveBeenCalled();
  });

  it('unbans a listed user and removes the row', async () => {
    render(<BanManagement />);
    await waitFor(() => expect(screen.getByText('bad@actor.test')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /unban/i }));
    await waitFor(() => expect(unbanMock).toHaveBeenCalledWith('sub-1', expect.any(String)));
    await waitFor(() => expect(screen.queryByText('bad@actor.test')).not.toBeInTheDocument());
  });

  it('shows a WAF-deferred note on the IP + Country tabs', () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'IP CIDR' }));
    expect(screen.getByText(/arrive with the AWS WAF/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Country' }));
    expect(screen.getByText(/arrive with the AWS WAF/i)).toBeInTheDocument();
  });
});
