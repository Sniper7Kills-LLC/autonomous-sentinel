import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import SubmitPage from './page';

// Submit short-circuits the Authenticator for already-signed-in callers
// (#728): identity comes from the root AuthProvider context. Default the
// stub to a signed-in caller so the form renders without mounting the
// Authenticator.
const authState = vi.fn<
  () => {
    loading: boolean;
    signedIn: boolean;
    username: string | null;
    sub: string | null;
    groups: string[];
  }
>(() => ({
  loading: false,
  signedIn: true,
  username: 'test@example.com',
  sub: 'sub-1',
  groups: [],
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => authState(),
}));

// `<Authenticator>` reaches for Amplify on mount; replace with a
// passthrough so the guest branch still renders the body underneath.
vi.mock('@/components/auth/AppAuthenticator', () => ({
  AppAuthenticator: ({ children }: { children: () => React.ReactNode }) => children(),
}));

// MessageSubmitForm pulls aws-amplify/data; stub it for the page smoke test.
vi.mock('@/components/submit/MessageSubmitForm', () => ({
  MessageSubmitForm: () => <div data-testid="submit-form" />,
}));

describe('SubmitPage', () => {
  beforeEach(() => {
    authState.mockReturnValue({
      loading: false,
      signedIn: true,
      username: 'test@example.com',
      sub: 'sub-1',
      groups: [],
    });
  });

  it('renders the form directly for a signed-in caller (no Authenticator flash)', () => {
    render(<SubmitPage />);
    expect(screen.getByTestId('submit-form')).toBeInTheDocument();
    expect(screen.queryByText(/checking your session/i)).not.toBeInTheDocument();
  });

  it('shows a session-check status without the form while auth is loading', () => {
    authState.mockReturnValue({
      loading: true,
      signedIn: false,
      username: null,
      sub: null,
      groups: [],
    });
    render(<SubmitPage />);
    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
    expect(screen.queryByTestId('submit-form')).not.toBeInTheDocument();
  });

  it('falls back to the Authenticator sign-in flow for guests', () => {
    authState.mockReturnValue({
      loading: false,
      signedIn: false,
      username: null,
      sub: null,
      groups: [],
    });
    render(<SubmitPage />);
    expect(screen.getByTestId('submit-form')).toBeInTheDocument();
  });
});
