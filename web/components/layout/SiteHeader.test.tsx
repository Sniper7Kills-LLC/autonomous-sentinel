import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SiteHeader } from './SiteHeader';

let callerGroups: string[] = [];
vi.mock('@/components/auth/AuthProvider', () => ({
  useCallerGroups: () => ({ groups: callerGroups, loading: false }),
}));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/messages',
  useRouter: () => ({ push }),
}));

describe('SiteHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    callerGroups = [];
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    push.mockReset();
  });

  it('always renders the primary nav + brand', () => {
    render(<SiteHeader />);
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /messages/i })).toBeInTheDocument();
  });

  it('hides the Admin link from members', () => {
    callerGroups = [];
    render(<SiteHeader />);
    expect(screen.queryByRole('link', { name: /^admin$/i })).not.toBeInTheDocument();
  });

  it('shows the Admin link for moderators and admins', () => {
    callerGroups = ['moderator'];
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: /^admin$/i })).toBeInTheDocument();
  });

  it('exposes an accessible site search input that submits to /search?q=', () => {
    render(<SiteHeader />);
    expect(screen.getByRole('search', { name: /site search/i })).toBeInTheDocument();
    const input = screen.getByRole('searchbox', { name: /search messages/i });
    fireEvent.change(input, { target: { value: 'skyking' } });
    fireEvent.submit(input);
    expect(push).toHaveBeenCalledWith('/search?q=skyking');
  });

  it('marks the active nav item with aria-current', () => {
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: /messages/i })).toHaveAttribute('aria-current', 'page');
  });
});
