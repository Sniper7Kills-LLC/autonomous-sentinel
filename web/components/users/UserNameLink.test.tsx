import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UserNameLink } from './UserNameLink';
import type { UserLabel } from '@/lib/users/label';

const getUserLabel = vi.fn<(sub: string) => Promise<UserLabel>>();
vi.mock('@/lib/users/label', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getUserLabel: (sub: string) => getUserLabel(sub),
  };
});

beforeEach(() => {
  getUserLabel.mockReset();
});

describe('UserNameLink', () => {
  it('resolves the sub to a display name and links to the profile', async () => {
    getUserLabel.mockResolvedValue({ sub: 'sub-123', label: 'Sky King', piiBlanked: false });
    render(<UserNameLink sub="sub-123" />);
    await waitFor(() => expect(screen.getByText('Sky King')).toBeInTheDocument());
    expect(screen.getByRole('link')).toHaveAttribute('href', '/users/view?id=sub-123');
  });

  it('shows the deactivated label for a self-deleted account', async () => {
    getUserLabel.mockResolvedValue({
      sub: 'gone',
      label: 'deactivated account',
      piiBlanked: true,
    });
    render(<UserNameLink sub="gone" />);
    await waitFor(() => expect(screen.getByText('deactivated account')).toBeInTheDocument());
  });

  it('shows an optimistic short sub immediately on mount', () => {
    getUserLabel.mockResolvedValue({
      sub: 'abcdefghijklmnop',
      label: 'abcdefgh…',
      piiBlanked: false,
    });
    render(<UserNameLink sub="abcdefghijklmnop" />);
    // Optimistic short-sub renders synchronously before resolution.
    expect(screen.getByText('abcdefgh…')).toBeInTheDocument();
  });
});
