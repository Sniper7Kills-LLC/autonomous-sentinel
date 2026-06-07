import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignInPanel } from './SignInPanel';

// AppAuthenticator is exercised in its own test; here just drive the
// render-prop body so the signed-in quick links are asserted.
vi.mock('@/components/auth/AppAuthenticator', () => ({
  AppAuthenticator: ({
    children,
  }: {
    children: (ctx: { signOut: () => void; user: unknown }) => React.ReactNode;
  }) => children({ signOut: () => {}, user: { signInDetails: { loginId: 'tester@example.com' } } }),
}));

describe('SignInPanel (#336)', () => {
  it('shows the signed-in quick links via the render prop', () => {
    render(<SignInPanel />);
    expect(screen.getByText(/tester@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /testing portal/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
