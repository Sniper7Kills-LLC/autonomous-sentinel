import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import SignInPage from './page';

vi.mock('@/components/auth/AmplifyConfigure', () => ({ AmplifyConfigure: () => null }));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

vi.mock('@/components/auth/AppAuthenticator', () => ({
  AppAuthenticator: ({
    children,
  }: {
    children: (ctx: { signOut: () => void; user: unknown }) => React.ReactNode;
  }) =>
    children({
      signOut: () => {},
      user: { username: 'tester', signInDetails: { loginId: 'tester@example.com' } },
    }),
}));

vi.mock('next/navigation', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/sign-in',
  };
});

describe('SignInPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the sign-in title + lede', () => {
    render(<SignInPage />);
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders the signed-in quick links through AppAuthenticator (#336)', () => {
    render(<SignInPage />);
    expect(screen.getByRole('link', { name: /testing portal/i })).toBeInTheDocument();
  });
});
