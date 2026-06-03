import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SearchPage from './page';

vi.mock('@/components/auth/AmplifyConfigure', () => ({
  AmplifyConfigure: () => null,
}));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

vi.mock('@/lib/messages/search', () => ({
  searchMessages: vi.fn().mockResolvedValue({
    items: [
      {
        id: 'm1',
        type: 'SKYKING',
        broadcastTs: '2026-05-27T12:00:00Z',
        sender: 'MAINSAIL',
        receiver: 'ANCHOR',
        body: 'FOXTROT 14 AB',
        confidence: 0.9,
        flaggedForReview: false,
        publishedAt: '2026-05-27T12:30:00Z',
      },
    ],
    nextToken: null,
  }),
}));

vi.mock('next/navigation', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => new URLSearchParams('q=foxtrot'),
    usePathname: () => '/search',
  };
});

describe('SearchPage', () => {
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

  it('renders the page title', () => {
    render(<SearchPage />);
    expect(screen.getByRole('heading', { name: /search/i })).toBeInTheDocument();
  });

  it('renders search hits with highlighted matches for the q param', async () => {
    render(<SearchPage />);
    await waitFor(() => {
      expect(screen.getByText('MAINSAIL')).toBeInTheDocument();
    });
    const marks = await screen.findAllByText(/foxtrot/i, { selector: 'mark' });
    expect(marks.length).toBeGreaterThan(0);
  });
});
