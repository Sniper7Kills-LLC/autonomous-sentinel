import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SiteHeader } from './SiteHeader';

const fetchCallerGroups = vi.fn();
vi.mock('@/lib/auth/roles', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, fetchCallerGroups: () => fetchCallerGroups() as Promise<string[]> };
});
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/messages' }));

describe('SiteHeader', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    fetchCallerGroups.mockReset();
  });

  it('always renders the primary nav + brand', () => {
    fetchCallerGroups.mockResolvedValue([]);
    render(<SiteHeader />);
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /messages/i })).toBeInTheDocument();
  });

  it('hides the Admin link from members', async () => {
    fetchCallerGroups.mockResolvedValue([]);
    render(<SiteHeader />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByRole('link', { name: /^admin$/i })).not.toBeInTheDocument();
  });

  it('shows the Admin link for moderators and admins', async () => {
    fetchCallerGroups.mockResolvedValue(['moderator']);
    render(<SiteHeader />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('link', { name: /^admin$/i })).toBeInTheDocument();
  });

  it('marks the active nav item with aria-current', () => {
    fetchCallerGroups.mockResolvedValue([]);
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: /messages/i })).toHaveAttribute('aria-current', 'page');
  });
});
