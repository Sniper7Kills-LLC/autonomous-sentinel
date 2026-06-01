import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RequireAuth } from './RequireAuth';

const replace = vi.fn();
let session: { loading: boolean; signedIn: boolean };

vi.mock('next/navigation', () => ({
  usePathname: () => '/uploads',
  useRouter: () => ({ replace }),
}));
vi.mock('@/components/account/SessionGreeting', () => ({
  useSessionState: () => session,
}));

describe('RequireAuth', () => {
  beforeEach(() => replace.mockReset());

  it('shows a checking notice while the session resolves', () => {
    session = { loading: true, signedIn: false };
    render(
      <RequireAuth>
        <div data-testid="protected" />
      </RequireAuth>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/checking your session/i);
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('redirects logged-out visitors to /sign-in with a next param', async () => {
    session = { loading: false, signedIn: false };
    render(
      <RequireAuth>
        <div data-testid="protected" />
      </RequireAuth>,
    );
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/sign-in?next=%2Fuploads');
    });
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('renders children for signed-in users', () => {
    session = { loading: false, signedIn: true };
    render(
      <RequireAuth>
        <div data-testid="protected" />
      </RequireAuth>,
    );
    expect(screen.getByTestId('protected')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
