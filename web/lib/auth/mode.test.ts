import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearAuthModeCache, getCachedAuthMode, resolveAuthMode } from './mode';

const getCurrentUserMock = vi.fn<() => Promise<unknown>>();

vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

vi.mock('@/lib/amplifyClient', () => ({
  configureAmplifyOnce: () => undefined,
}));

describe('resolveAuthMode', () => {
  beforeEach(() => {
    clearAuthModeCache();
    getCurrentUserMock.mockReset();
  });
  afterEach(() => {
    clearAuthModeCache();
  });

  it('returns `userPool` when a current user exists', async () => {
    getCurrentUserMock.mockResolvedValue({ username: 'tester' });
    expect(await resolveAuthMode()).toBe('userPool');
  });

  it('returns `identityPool` when no current user', async () => {
    getCurrentUserMock.mockRejectedValue(new Error('UserUnAuthenticatedException'));
    expect(await resolveAuthMode()).toBe('identityPool');
  });

  it('caches the resolved value across repeated calls', async () => {
    getCurrentUserMock.mockResolvedValue({ username: 'tester' });
    await resolveAuthMode();
    await resolveAuthMode();
    await resolveAuthMode();
    expect(getCurrentUserMock).toHaveBeenCalledTimes(1);
  });

  it('clearAuthModeCache forces a re-probe', async () => {
    getCurrentUserMock.mockResolvedValue({ username: 'tester' });
    await resolveAuthMode();
    clearAuthModeCache();
    getCurrentUserMock.mockRejectedValueOnce(new Error('signed out'));
    expect(await resolveAuthMode()).toBe('identityPool');
  });
});

describe('getCachedAuthMode', () => {
  beforeEach(() => clearAuthModeCache());

  it('defaults to identityPool before any resolve', () => {
    expect(getCachedAuthMode()).toBe('identityPool');
  });

  it('reflects the last resolved value', async () => {
    getCurrentUserMock.mockResolvedValue({ username: 't' });
    await resolveAuthMode();
    expect(getCachedAuthMode()).toBe('userPool');
  });
});
