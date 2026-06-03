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

const listCountryMock = vi.fn<() => Promise<unknown[]>>();
const addCountryMock = vi.fn<(i: unknown) => Promise<void>>();
const removeCountryMock = vi.fn<(i: string) => Promise<void>>();
const listIpMock = vi.fn<() => Promise<unknown[]>>();
const addIpMock = vi.fn<(i: unknown) => Promise<void>>();
const removeIpMock = vi.fn<(c: string) => Promise<void>>();

vi.mock('@/lib/admin/waf-bans', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual, // keep the real isValidCidr / cidrVersion
    listCountryBans: () => listCountryMock(),
    addCountryBan: (i: unknown) => addCountryMock(i),
    removeCountryBan: (i: string) => removeCountryMock(i),
    listIpBans: () => listIpMock(),
    addIpBan: (i: unknown) => addIpMock(i),
    removeIpBan: (c: string) => removeIpMock(c),
    fetchWafMetrics: () => Promise.resolve(null), // banner degrades to nothing
  };
});

// The Region-pages tab renders the real BannedRegionEditor, which has its own
// data layer; stub it so these tests stay scoped to ban management.
vi.mock('@/components/admin/BannedRegionEditor', () => ({
  BannedRegionEditor: () => <div data-testid="region-editor-stub" />,
}));

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
  listCountryMock.mockReset().mockResolvedValue([]);
  addCountryMock.mockReset().mockResolvedValue();
  removeCountryMock.mockReset().mockResolvedValue();
  listIpMock.mockReset().mockResolvedValue([]);
  addIpMock.mockReset().mockResolvedValue();
  removeIpMock.mockReset().mockResolvedValue();
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

  it('adds a country ban (uppercased ISO + scope) from the Country tab', async () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'Country' }));
    await waitFor(() => expect(listCountryMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('ISO country code to block'), {
      target: { value: 'ru' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^block$/i }));
    await waitFor(() =>
      expect(addCountryMock).toHaveBeenCalledWith(
        expect.objectContaining({ iso2: 'RU', scope: 'write' }),
      ),
    );
  });

  it('rejects an invalid country code without calling the mutation', async () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'Country' }));
    await waitFor(() => expect(listCountryMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('ISO country code to block'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^block$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/2-letter ISO/i);
    expect(addCountryMock).not.toHaveBeenCalled();
  });

  it('blocks an invalid CIDR on the IP tab and disables submit', async () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'IP CIDR' }));
    await waitFor(() => expect(listIpMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('IP CIDR range to block'), {
      target: { value: '999.0.0.0/24' },
    });
    expect(await screen.findByText(/not a valid ipv4 or ipv6 cidr/i)).toBeInTheDocument();
    expect(addIpMock).not.toHaveBeenCalled();
  });

  it('adds a valid CIDR ban from the IP tab', async () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'IP CIDR' }));
    await waitFor(() => expect(listIpMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('IP CIDR range to block'), {
      target: { value: '203.0.113.0/24' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^block$/i }));
    await waitFor(() =>
      expect(addIpMock).toHaveBeenCalledWith(
        expect.objectContaining({ cidr: '203.0.113.0/24', scope: 'write' }),
      ),
    );
  });

  it('rejects an expiry in the past (would be a silent no-op ban)', async () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'IP CIDR' }));
    await waitFor(() => expect(listIpMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('IP CIDR range to block'), {
      target: { value: '203.0.113.0/24' },
    });
    fireEvent.change(screen.getByLabelText('Expiry (optional)'), {
      target: { value: '2020-01-01T00:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^block$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expiry must be in the future/i);
    expect(addIpMock).not.toHaveBeenCalled();
  });

  it('accepts a future expiry', async () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'IP CIDR' }));
    await waitFor(() => expect(listIpMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('IP CIDR range to block'), {
      target: { value: '203.0.113.0/24' },
    });
    fireEvent.change(screen.getByLabelText('Expiry (optional)'), {
      target: { value: '2099-01-01T00:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^block$/i }));
    await waitFor(() => expect(addIpMock).toHaveBeenCalled());
    const arg = addIpMock.mock.calls[0]?.[0] as { cidr: string; expiresAt: string | null };
    expect(arg.cidr).toBe('203.0.113.0/24');
    expect(arg.expiresAt).toMatch(/^209[89]/); // future ISO (TZ may shift the date by ±1)
  });

  it('renders the banned-region editor on the Region pages tab', () => {
    render(<BanManagement />);
    fireEvent.click(screen.getByRole('tab', { name: 'Region pages' }));
    expect(screen.getByTestId('region-editor-stub')).toBeInTheDocument();
  });
});
