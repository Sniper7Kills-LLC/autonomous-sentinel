import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth, useCallerGroups } from './AuthProvider';

const getCurrentUser = vi.fn<() => Promise<unknown>>();
const fetchAuthSession = vi.fn<() => Promise<unknown>>();
const configureAmplifyOnce = vi.fn<() => void>();
const hubUnsubscribe = vi.fn<() => void>();
let hubCallback: ((data: { payload: { event: string } }) => void) | null = null;

vi.mock('@/lib/amplifyClient', () => ({ configureAmplifyOnce: () => configureAmplifyOnce() }));
vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: () => getCurrentUser(),
  fetchAuthSession: () => fetchAuthSession(),
}));
vi.mock('aws-amplify/utils', () => ({
  Hub: {
    listen: (_channel: string, cb: (data: { payload: { event: string } }) => void) => {
      hubCallback = cb;
      return hubUnsubscribe;
    },
  },
}));

function Probe() {
  const { loading, signedIn, username, sub } = useAuth();
  const { groups } = useCallerGroups();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="signedIn">{String(signedIn)}</span>
      <span data-testid="username">{username ?? ''}</span>
      <span data-testid="sub">{sub ?? ''}</span>
      <span data-testid="groups">{groups.join(',')}</span>
    </div>
  );
}

const signedInUser = {
  username: 'sky',
  userId: 'user-1',
  signInDetails: { loginId: 'sky@example.io' },
};
const sessionWithGroups = (groups: string[]) => ({
  tokens: { idToken: { payload: { sub: 'sub-1', 'cognito:groups': groups } } },
});

describe('AuthProvider', () => {
  beforeEach(() => {
    getCurrentUser.mockReset();
    fetchAuthSession.mockReset();
    configureAmplifyOnce.mockReset();
    hubUnsubscribe.mockReset();
    hubCallback = null;
  });

  it('fetches the session once and exposes identity + groups', async () => {
    getCurrentUser.mockResolvedValue(signedInUser);
    fetchAuthSession.mockResolvedValue(sessionWithGroups(['admin']));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('signedIn')).toHaveTextContent('true'));
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('username')).toHaveTextContent('sky@example.io');
    expect(screen.getByTestId('sub')).toHaveTextContent('sub-1');
    expect(screen.getByTestId('groups')).toHaveTextContent('admin');
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
    expect(configureAmplifyOnce).toHaveBeenCalled();
  });

  it('resolves to signed-out when there is no current user', async () => {
    getCurrentUser.mockRejectedValue(new Error('no user'));
    fetchAuthSession.mockResolvedValue({});

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('signedIn')).toHaveTextContent('false');
    expect(screen.getByTestId('groups')).toHaveTextContent('');
  });

  it('clears state on Hub signedOut and refetches on signedIn', async () => {
    getCurrentUser.mockResolvedValue(signedInUser);
    fetchAuthSession.mockResolvedValue(sessionWithGroups([]));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('signedIn')).toHaveTextContent('true'));
    await waitFor(() => expect(hubCallback).not.toBeNull());

    act(() => hubCallback!({ payload: { event: 'signedOut' } }));
    await waitFor(() => expect(screen.getByTestId('signedIn')).toHaveTextContent('false'));

    act(() => hubCallback!({ payload: { event: 'signedIn' } }));
    await waitFor(() => expect(screen.getByTestId('signedIn')).toHaveTextContent('true'));
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });
});
