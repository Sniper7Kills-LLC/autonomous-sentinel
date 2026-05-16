import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent, Context } from 'aws-lambda';
import { handler } from './handler';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

function makeEvent(
  overrides: Partial<PostConfirmationTriggerEvent> = {},
): PostConfirmationTriggerEvent {
  const base: PostConfirmationTriggerEvent = {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_TESTPOOL',
    userName: 'test-user-id',
    callerContext: { awsSdkVersion: '0', clientId: 'test-client' },
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    request: { userAttributes: { sub: 'sub-1', email: 'a@example.com' } },
    response: {},
  };
  return { ...base, ...overrides };
}

describe('postConfirmation handler', () => {
  beforeEach(() => {
    cognitoMock.reset();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('adds the new user to the member group on ConfirmSignUp', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    const event = makeEvent();

    await handler(event, {} as Context, () => undefined);

    const calls = cognitoMock.commandCalls(AdminAddUserToGroupCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      UserPoolId: 'us-east-1_TESTPOOL',
      Username: 'test-user-id',
      GroupName: 'member',
    });
  });

  it('is idempotent on ConfirmForgotPassword (still issues the call; SDK is no-op)', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    const event = makeEvent({ triggerSource: 'PostConfirmation_ConfirmForgotPassword' });

    await handler(event, {} as Context, () => undefined);

    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(1);
  });

  it('skips group assignment for unknown trigger sources', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    // Cast lets us simulate an unknown trigger source without widening the
    // PostConfirmationTriggerEvent union in the production handler.
    const event = makeEvent({
      triggerSource:
        'PostConfirmation_Something' as unknown as PostConfirmationTriggerEvent['triggerSource'],
    });

    await handler(event, {} as Context, () => undefined);

    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
  });

  it('propagates SDK errors so Cognito retries / surfaces the failure', async () => {
    cognitoMock.on(AdminAddUserToGroupCommand).rejects(new Error('boom'));
    const event = makeEvent();

    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow('boom');
  });
});
