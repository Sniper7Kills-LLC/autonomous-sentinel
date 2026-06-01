import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import StatsIndexPage from './page';

vi.mock('@/components/auth/AmplifyConfigure', () => ({ AmplifyConfigure: () => null }));
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

vi.mock('@/lib/messages/query', () => ({
  listMessages: vi.fn().mockResolvedValue({ items: [], nextToken: null }),
}));

// Recharts uses ResizeObserver + window dimensions that jsdom lacks
// — render a passthrough so the chart shells still exercise.
vi.mock('recharts', () => ({
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bar">{children}</div>
  ),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('next/navigation', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/stats',
  };
});

describe('StatsIndexPage', () => {
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

  it('renders deep-nav with overview marked as current', () => {
    render(<StatsIndexPage />);
    const current = screen.getByText('Overview');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('shows all three chart shells on the overview', async () => {
    render(<StatsIndexPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /daily counts/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /character frequency/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /codeword frequency/i })).toBeInTheDocument();
    });
  });
});
