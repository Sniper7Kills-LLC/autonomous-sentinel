import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import TransparencyPage from './page';

const { fetchCostSnapshots, fetchRevenueSnapshots, fetchCallerGroups, runCostSnapshotNow } =
  vi.hoisted(() => ({
    fetchCostSnapshots: vi.fn(),
    fetchRevenueSnapshots: vi.fn(),
    fetchCallerGroups: vi.fn(),
    runCostSnapshotNow: vi.fn(),
  }));

vi.mock('@/lib/cost/transparency', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    fetchCostSnapshots,
    fetchRevenueSnapshots,
    runCostSnapshotNow,
  };
});

vi.mock('@/lib/auth/roles', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    fetchCallerGroups,
  };
});

// Recharts needs ResizeObserver / window sizing jsdom lacks — passthrough.
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

const COST_ROWS = [
  {
    snapshotDate: '2026-05-31',
    subject: 'AWS Lambda',
    category: 'AWS_SERVICE',
    usdAmount: 2.5,
    unit: 'USD',
    meta: {},
  },
  {
    snapshotDate: '2026-05-31',
    subject: 'recordings/originals/',
    category: 'S3_PREFIX',
    usdAmount: 0,
    unit: 'bytes',
    meta: { bytes: 1048576, objects: 4 },
  },
  {
    snapshotDate: '2026-05-31',
    subject: 'preprocess',
    category: 'LAMBDA_FUNCTION',
    usdAmount: 0,
    unit: 'GB-seconds',
    meta: { invocations: 12, durationGbSeconds: 3.2 },
  },
];

describe('TransparencyPage (#303)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCostSnapshots.mockResolvedValue(COST_ROWS);
    fetchRevenueSnapshots.mockResolvedValue([]);
    fetchCallerGroups.mockResolvedValue([]);
    runCostSnapshotNow.mockResolvedValue({ status: 'queued' });
  });

  it('renders the cost panel with the AWS total for everyone', async () => {
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByText(/Total: \$2\.50/)).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /AWS spend/i })).toBeInTheDocument();
    // Storage + compute breakdown line items.
    expect(screen.getByText('recordings/originals/')).toBeInTheDocument();
    expect(screen.getByText('preprocess')).toBeInTheDocument();
  });

  it('hides the revenue panel for a guest / non-mod caller', async () => {
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByText(/Total: \$2\.50/)).toBeInTheDocument());
    expect(screen.queryByText(/Revenue \(admin/i)).not.toBeInTheDocument();
    expect(fetchRevenueSnapshots).not.toHaveBeenCalled();
  });

  it('shows the revenue panel (empty state) for an admin caller', async () => {
    fetchCallerGroups.mockResolvedValue(['admin']);
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByText(/Revenue \(admin/i)).toBeInTheDocument());
    expect(screen.getByText(/No revenue data yet/i)).toBeInTheDocument();
    expect(fetchRevenueSnapshots).toHaveBeenCalled();
  });

  it('renders revenue figures when an admin has revenue rows', async () => {
    fetchCallerGroups.mockResolvedValue(['moderator']);
    fetchRevenueSnapshots.mockResolvedValue([
      {
        snapshotDate: '2026-05-31',
        subject: 'one-time',
        category: 'REVENUE_DONATION',
        usdAmount: 10,
        unit: 'USD',
        meta: {},
      },
    ]);
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByText(/REVENUE_DONATION: \$10\.00/)).toBeInTheDocument());
  });

  it('surfaces a cost-load error', async () => {
    fetchCostSnapshots.mockRejectedValue(new Error('boom'));
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/));
  });

  it('hides the "Sync now" button for a guest', async () => {
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByText(/Total: \$2\.50/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
  });

  it('hides the "Sync now" button for a moderator (admin-only)', async () => {
    fetchCallerGroups.mockResolvedValue(['moderator']);
    render(<TransparencyPage />);
    await waitFor(() => expect(screen.getByText(/Revenue \(admin/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
  });

  it('shows "Sync now" for an admin and queues the mutation + delayed refetch on click', async () => {
    vi.useFakeTimers();
    try {
      fetchCallerGroups.mockResolvedValue(['admin']);
      render(<TransparencyPage />);

      // Drain the mount effect (promises) under fake timers.
      const btn = await vi.waitFor(() => screen.getByRole('button', { name: /sync now/i }));
      // One initial cost fetch on mount.
      expect(fetchCostSnapshots).toHaveBeenCalledTimes(1);

      fireEvent.click(btn);

      await vi.waitFor(() => expect(runCostSnapshotNow).toHaveBeenCalledTimes(1));
      // Queued status (NOT row counts — the worker runs async).
      await vi.waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(/Sync queued — refresh in ~1 min/i),
      );
      // Refetch is deferred ~1 min; not yet fired.
      expect(fetchCostSnapshots).toHaveBeenCalledTimes(1);

      // Advance past the refetch delay → second cost fetch.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchCostSnapshots).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error when the sync mutation fails', async () => {
    fetchCallerGroups.mockResolvedValue(['admin']);
    runCostSnapshotNow.mockRejectedValue(new Error('not authorized'));
    render(<TransparencyPage />);

    const btn = await screen.findByRole('button', { name: /sync now/i });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(screen.getByText(/Sync failed: not authorized/i)).toBeInTheDocument(),
    );
  });
});
