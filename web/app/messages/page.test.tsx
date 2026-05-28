import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MessagesPage from './page';

vi.mock('@/components/auth/AmplifyConfigure', () => ({
  AmplifyConfigure: () => null,
}));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));
vi.mock('@/lib/messages/query', () => ({
  listMessages: vi.fn().mockResolvedValue({
    items: [
      {
        id: 'm1',
        type: 'SKYKING',
        broadcastTs: '2026-05-27T12:00:00Z',
        sender: 'MAINSAIL',
        receiver: 'ANCHOR',
        body: 'PT3 14 AB',
        confidence: 0.9,
        flaggedForReview: false,
        publishedAt: '2026-05-27T12:30:00Z',
        characterCount: 30,
        codewordCount: 0,
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
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/messages',
  };
});

describe('MessagesPage', () => {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the page eyebrow + title', () => {
    render(<MessagesPage />);
    expect(screen.getByRole('heading', { name: /messages/i })).toBeInTheDocument();
  });

  it('lists messages returned by the AppSync query', async () => {
    render(<MessagesPage />);
    await waitFor(() => {
      expect(screen.getByText('MAINSAIL')).toBeInTheDocument();
      expect(screen.getByText('ANCHOR')).toBeInTheDocument();
    });
  });

  it('shows the type filter input when no forcedType applied', () => {
    render(<MessagesPage />);
    expect(screen.getByLabelText(/type/i)).toBeInTheDocument();
  });
});
