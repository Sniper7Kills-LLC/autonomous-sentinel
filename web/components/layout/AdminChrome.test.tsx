import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdminChrome } from './AdminChrome';

const replace = vi.fn();
const fetchCallerGroups = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ replace }),
}));
vi.mock('@/lib/auth/roles', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, fetchCallerGroups: () => fetchCallerGroups() as Promise<string[]> };
});
vi.mock('@/components/auth/AmplifyConfigure', () => ({ AmplifyConfigure: () => null }));
vi.mock('@/components/theme/ThemeToggle', () => ({ ThemeToggle: () => <div /> }));

describe('AdminChrome', () => {
  beforeEach(() => {
    replace.mockReset();
    fetchCallerGroups.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the sidebar nav + children for admins', async () => {
    fetchCallerGroups.mockResolvedValue(['admin']);
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
    fetchCallerGroups.mockResolvedValue([]);
    render(
      <AdminChrome>
        <div data-testid="admin-content" />
      </AdminChrome>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/?denied=admin'));
    expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
  });
});
