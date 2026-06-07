import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PostAuthenticationTriggerEvent, Context } from 'aws-lambda';
import { handler, __setDispatcher, type Dispatcher } from './handler';
import type { FederatedIdentityInput } from '../federatedUserSync/ensure';

function event(userAttributes: Record<string, string>): PostAuthenticationTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_TEST',
    userName: 'u',
    triggerSource: 'PostAuthentication_Authentication',
    callerContext: { awsSdkVersion: '0', clientId: 'c' },
    request: { userAttributes, newDeviceUsed: false },
    response: {},
  };
}

describe('postAuthentication handler (#783)', () => {
  let dispatch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dispatch = vi.fn<(j: FederatedIdentityInput) => Promise<void>>().mockResolvedValue(undefined);
    __setDispatcher(dispatch as unknown as Dispatcher);
  });
  afterEach(() => __setDispatcher(undefined));

  it('queues a sync job for a federated sign-in', async () => {
    await handler(
      event({
        identities: '[{"providerName":"Discord"}]',
        sub: 'discord_1',
        email: 'a@b.c',
        name: 'Mainsail',
        preferred_username: 'mainsail',
      }),
      {} as Context,
      () => undefined,
    );
    expect(dispatch).toHaveBeenCalledWith({
      cognitoSub: 'discord_1',
      email: 'a@b.c',
      displayName: 'Mainsail',
      preferredUsername: 'mainsail',
    });
  });

  it('does nothing for a native sign-in', async () => {
    await handler(event({ sub: 'native_1', email: 'a@b.c' }), {} as Context, () => undefined);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('swallows dispatch failure (never blocks sign-in)', async () => {
    dispatch.mockRejectedValue(new Error('sqs down'));
    const ev = event({ identities: '[{"x":1}]', sub: 's' });
    await expect(handler(ev, {} as Context, () => undefined)).resolves.toBe(ev);
  });
});
