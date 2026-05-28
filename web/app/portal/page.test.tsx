import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';

// `<Authenticator>` from @aws-amplify/ui-react reaches for Amplify
// Hub + Auth on mount, which we don't want to spin up in unit tests.
// Replace it with a passthrough that renders children with a stub
// `user` / `signOut`, exercising the portal UI underneath.
vi.mock('@aws-amplify/ui-react', () => ({
  Authenticator: ({
    children,
  }: {
    children: (ctx: { signOut: () => void; user: unknown }) => React.ReactNode;
  }) =>
    children({
      signOut: () => {},
      user: { username: 'test-user', signInDetails: { loginId: 'test@example.com' } },
    }),
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

  it('renders the project codename in the brand strip', () => {
    render(<HomePage />);
    expect(screen.getAllByText(/AUTONOMOUS\s*SENTINEL/i).length).toBeGreaterThan(0);
  });

  it('frames itself as the pre-launch testing portal', () => {
    render(<HomePage />);
    expect(screen.getByText(/TESTING PORTAL/i)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /drop an audio capture/i,
      }),
    ).toBeInTheDocument();
  });

  it('mounts the upload flow when authenticated', () => {
    render(<HomePage />);
    expect(screen.getByTestId('upload-flow')).toBeInTheDocument();
  });
});
