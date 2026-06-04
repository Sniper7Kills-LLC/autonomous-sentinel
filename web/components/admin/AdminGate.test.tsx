import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminGate } from './AdminGate';

// AdminGate now reads caller groups from the root AuthProvider context
// (#726) rather than probing Cognito per mount. Drive the gate by
// stubbing the context hook.
const callerGroups = vi.fn<() => { groups: string[]; loading: boolean }>();
vi.mock('@/components/auth/AuthProvider', () => ({
  useCallerGroups: () => callerGroups(),
}));

beforeEach(() => {
  callerGroups.mockReset();
});

describe('AdminGate', () => {
  it('renders children synchronously for an admin (no checking flash)', () => {
    callerGroups.mockReturnValue({ groups: ['admin'], loading: false });
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    // Resolved from context on first render — never shows the access check.
    expect(screen.queryByText(/checking your access/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('protected')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-denied')).not.toBeInTheDocument();
  });

  it('shows the checking notice while the session is still loading', () => {
    callerGroups.mockReturnValue({ groups: [], loading: true });
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    expect(screen.getByText(/checking your access/i)).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('hides children and shows the denied notice for a moderator', () => {
    callerGroups.mockReturnValue({ groups: ['moderator'], loading: false });
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    expect(screen.getByTestId('admin-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('hides children for a guest / member', () => {
    callerGroups.mockReturnValue({ groups: [], loading: false });
    render(
      <AdminGate>
        <div data-testid="protected">secret</div>
      </AdminGate>,
    );
    expect(screen.getByTestId('admin-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });
});
