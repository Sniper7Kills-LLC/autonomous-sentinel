import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import LandingPage from './page';
import { AuthProvider } from '@/components/auth/AuthProvider';

vi.mock('@/lib/amplifyClient', () => ({ configureAmplifyOnce: vi.fn() }));
vi.mock('aws-amplify/utils', () => ({ Hub: { listen: () => () => {} } }));
vi.mock('@/components/auth/AmplifyConfigure', () => ({ AmplifyConfigure: () => null }));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
vi.mock('@/lib/messages/query', () => ({
  listMessages: vi.fn().mockResolvedValue({ items: [], nextToken: null }),
}));
vi.mock('next/navigation', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/',
  };
});

const getCurrentUserMock = vi.fn<() => Promise<unknown>>();
const fetchAuthSessionMock = vi.fn<() => Promise<unknown>>();
vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: () => getCurrentUserMock(),
  fetchAuthSession: () => fetchAuthSessionMock(),
}));

describe('LandingPage', () => {
  beforeEach(() => {
    getCurrentUserMock.mockReset();
    fetchAuthSessionMock.mockReset();
    fetchAuthSessionMock.mockResolvedValue({
      tokens: { idToken: { payload: { sub: 'sub-123' } } },
    });
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

  it('renders the hero and CTAs for guests', async () => {
    getCurrentUserMock.mockRejectedValue(new Error('not signed in'));
    render(
      <AuthProvider>
        <LandingPage />
      </AuthProvider>,
    );
    expect(
      screen.getByRole('heading', { name: /catalogue the emergency action message channel/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /browse the archive/i })).toBeInTheDocument();
    // Personalized panel must NOT appear for guests.
    await waitFor(() => {
      expect(screen.queryByLabelText('Signed-in actions')).toBeNull();
    });
  });

  it('shows personalized panel when authenticated', async () => {
    getCurrentUserMock.mockResolvedValue({
      username: 'member',
      signInDetails: { loginId: 'member@example.com' },
    });
    render(
      <AuthProvider>
        <LandingPage />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Signed-in actions')).toBeInTheDocument();
    });
    expect(screen.getByText(/member@example\.com/i)).toBeInTheDocument();
  });
});
