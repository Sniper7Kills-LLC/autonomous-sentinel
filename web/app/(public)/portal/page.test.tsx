import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';

// `<Authenticator>` from @aws-amplify/ui-react reaches for Amplify
// Hub + Auth on mount, which we don't want to spin up in unit tests.
// Replace it with a passthrough that renders children with a stub
// `user` / `signOut`, exercising the portal guest path underneath.
vi.mock('@/components/auth/AppAuthenticator', () => ({
  AppAuthenticator: ({
    children,
  }: {
    children: (ctx: { signOut: () => void; user: unknown }) => React.ReactNode;
  }) =>
    children({
      signOut: () => {},
      user: { username: 'test-user', signInDetails: { loginId: 'test@example.com' } },
    }),
}));

// The portal short-circuits the Authenticator for already-signed-in
// callers (#726): identity comes from the root AuthProvider context.
// Default the stub to a signed-in caller so the upload flow renders
// without mounting the Authenticator.
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

// Skip the Amplify SDK calls during render — the AmplifyConfigure
// component is unit-of-trust here; it's covered separately.
vi.mock('@/components/auth/AmplifyConfigure', () => ({
  AmplifyConfigure: () => null,
}));

// UploadFlow imports `aws-amplify/storage` + `aws-amplify/data` which
// fail to initialise without a configured Amplify. Stub the whole
// component out for the page-level smoke test.
vi.mock('@/components/portal/UploadFlow', () => ({
  UploadFlow: () => <div data-testid="upload-flow" />,
}));

// ThemeToggle reads context from ThemeProvider; the page-level smoke
// test renders HomePage in isolation, not the root layout. Stub it.
vi.mock('@/components/theme/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

describe('HomePage (testing portal)', () => {
  beforeEach(() => {
    authState.mockReturnValue({
      loading: false,
      signedIn: true,
      username: 'test@example.com',
      sub: 'sub-1',
      groups: [],
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('frames itself as the pre-launch testing portal', () => {
    // Site chrome (brand strip, header) is now provided by the route-group
    // layout (#71), not the page — the page renders only its own content.
    render(<HomePage />);
    expect(
      screen.getByRole('heading', {
        name: /drop an audio capture/i,
      }),
    ).toBeInTheDocument();
  });

  it('mounts the upload flow when authenticated (no Authenticator flash)', () => {
    render(<HomePage />);
    expect(screen.getByTestId('upload-flow')).toBeInTheDocument();
    expect(screen.queryByText(/checking your session/i)).not.toBeInTheDocument();
  });

  it('shows a session-check status without the upload flow while auth is loading', () => {
    authState.mockReturnValue({
      loading: true,
      signedIn: false,
      username: null,
      sub: null,
      groups: [],
    });
    render(<HomePage />);
    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
    expect(screen.queryByTestId('upload-flow')).not.toBeInTheDocument();
  });

  it('falls back to the Authenticator sign-in flow for guests', () => {
    authState.mockReturnValue({
      loading: false,
      signedIn: false,
      username: null,
      sub: null,
      groups: [],
    });
    render(<HomePage />);
    // The mocked Authenticator passes through to the upload UI.
    expect(screen.getByTestId('upload-flow')).toBeInTheDocument();
  });
});
