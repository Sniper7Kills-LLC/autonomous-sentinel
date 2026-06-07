import { describe, it, expect, vi } from 'vitest';
import {
  ensureFederatedUser,
  type FederatedUserStore,
  type FederatedIdentityInput,
} from './ensure';

function makeStore(over: Partial<FederatedUserStore> = {}): {
  store: FederatedUserStore;
  userExists: ReturnType<typeof vi.fn>;
  createUser: ReturnType<typeof vi.fn>;
  ensureReputation: ReturnType<typeof vi.fn>;
} {
  const userExists = vi.fn<(s: string) => Promise<boolean>>().mockResolvedValue(false);
  const createUser = vi
    .fn<(i: FederatedIdentityInput) => Promise<boolean>>()
    .mockResolvedValue(true);
  const ensureReputation = vi.fn<(s: string) => Promise<void>>().mockResolvedValue(undefined);
  return {
    userExists,
    createUser,
    ensureReputation,
    store: { userExists, createUser, ensureReputation, ...over },
  };
}

const input: FederatedIdentityInput = {
  cognitoSub: 'discord_123',
  email: 'op@example.com',
  displayName: 'Mainsail Operator',
  preferredUsername: 'mainsail',
};

describe('ensureFederatedUser (#783)', () => {
  it('creates the User + Reputation rows when absent', async () => {
    const m = makeStore();
    const outcome = await ensureFederatedUser(m.store, input);
    expect(outcome).toBe('created');
    expect(m.createUser).toHaveBeenCalledWith(input);
    expect(m.ensureReputation).toHaveBeenCalledWith('discord_123');
  });

  it('is a no-op when the User row already exists', async () => {
    const m = makeStore();
    m.userExists.mockResolvedValue(true);
    const outcome = await ensureFederatedUser(m.store, input);
    expect(outcome).toBe('exists');
    expect(m.createUser).not.toHaveBeenCalled();
    expect(m.ensureReputation).not.toHaveBeenCalled();
  });

  it('treats a lost conditional-create race as exists (no reputation write)', async () => {
    const m = makeStore();
    m.createUser.mockResolvedValue(false);
    const outcome = await ensureFederatedUser(m.store, input);
    expect(outcome).toBe('exists');
    expect(m.ensureReputation).not.toHaveBeenCalled();
  });

  it('skips when there is no cognito sub', async () => {
    const m = makeStore();
    const outcome = await ensureFederatedUser(m.store, { ...input, cognitoSub: '' });
    expect(outcome).toBe('skipped');
    expect(m.userExists).not.toHaveBeenCalled();
  });
});
