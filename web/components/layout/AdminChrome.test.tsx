import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdminChrome } from './AdminChrome';

const replace = vi.fn();
let callerGroups: { groups: string[]; loading: boolean } = { groups: [], loading: false };

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ replace }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useCallerGroups: () => callerGroups,
}));
vi.mock('@/components/auth/AmplifyConfigure', () => ({ AmplifyConfigure: () => null }));
vi.mock('@/components/theme/ThemeToggle', () => ({ ThemeToggle: () => <div /> }));

describe('AdminChrome', () => {
  beforeEach(() => {
    replace.mockReset();
    callerGroups = { groups: [], loading: false };
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the sidebar nav + children for admins', async () => {
    callerGroups = { groups: ['admin'], loading: false };
    render(
      <AdminChrome>
        <div data-testid="admin-content" />
      </AdminChrome>,
    );
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: /admin sections/i })).toBeInTheDocument();
      expect(screen.getByTestId('admin-content')).toBeInTheDocument();
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects non-privileged users away from the admin area', async () => {
    callerGroups = { groups: [], loading: false };
    render(
      <AdminChrome>
        <div data-testid="admin-content" />
      </AdminChrome>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/?denied=admin'));
    expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
  });
});
