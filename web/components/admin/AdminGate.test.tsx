import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdminGate } from './AdminGate';

const groupsMock = vi.fn<() => Promise<string[]>>();
vi.mock('@/lib/auth/roles', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    fetchCallerGroups: (): Promise<string[]> => groupsMock(),
  };
});

beforeEach(() => {
  groupsMock.mockReset();
});

describe('AdminGate', () => {
  it('renders children for an admin', async () => {
    groupsMock.mockResolvedValue(['admin']);
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    await waitFor(() => expect(screen.getByTestId('protected')).toBeInTheDocument());
    expect(screen.queryByTestId('admin-denied')).not.toBeInTheDocument();
  });

  it('hides children and shows the denied notice for a moderator', async () => {
    groupsMock.mockResolvedValue(['moderator']);
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    await waitFor(() => expect(screen.getByTestId('admin-denied')).toBeInTheDocument());
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('hides children for a guest / member', async () => {
    groupsMock.mockResolvedValue([]);
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    await waitFor(() => expect(screen.getByTestId('admin-denied')).toBeInTheDocument());
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('denies when the session lookup throws', async () => {
    groupsMock.mockRejectedValue(new Error('no session'));
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    await waitFor(() => expect(screen.getByTestId('admin-denied')).toBeInTheDocument());
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });
});
