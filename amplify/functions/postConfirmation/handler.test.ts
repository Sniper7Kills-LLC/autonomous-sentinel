import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDataDeps,
  __resetDataDeps,
  __setLegacyClaimDispatcher,
  type LegacyClaimDispatchPayload,
} from './handler';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

/**
 * Shape of the Amplify Data client stub used by the handler tests. Mirrors
 * the narrow surface in `handler.ts` so we can assert what the handler
 * writes into DynamoDB without standing up a real Amplify runtime.
 */
interface UserRow {
  cognitoSub: string;
  email?: string | null;
  claimStatus?: string | null;
  piiBlanked?: boolean | null;
  legacyEmail?: string | null;
  legacyUserId?: number | null;
}

function makeStubDataClient(opts: { existingByEmail?: UserRow | null } = {}): {
  client: {
    models: {
      User: {
        listUserByEmail: ReturnType<typeof vi.fn>;
        create: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
    };
  };
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  listByEmailSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn((input: UserRow) =>
    Promise.resolve({
      data: { ...input },
      errors: undefined,
    }),
  );
  const updateSpy = vi.fn((input: Partial<UserRow> & { cognitoSub: string }) =>
    Promise.resolve({
      data: { ...input },
      errors: undefined,
    }),
  );
  const listByEmailSpy = vi.fn(() =>
    Promise.resolve({
      data: opts.existingByEmail ? [opts.existingByEmail] : [],
      errors: undefined,
    }),
  );
  return {
    createSpy,
    updateSpy,
    listByEmailSpy,
    client: {
      models: {
        User: {
          listUserByEmail: listByEmailSpy,
          create: createSpy,
          update: updateSpy,
        },
      },
    },
  };
}

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
  let stub: ReturnType<typeof makeStubDataClient>;

  beforeEach(() => {
    cognitoMock.reset();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    stub = makeStubDataClient();
    __setDataDeps({ client: stub.client });
  });

  afterAll(() => {
    __resetDataDeps();
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

/**
 * Tests for the second half of postConfirmation: creating the User row
 * keyed on the Cognito sub from `event.request.userAttributes.sub`. This
 * is the wiring referenced in CLAUDE.md's "post-confirmation Lambda is
 * the right hook to create the User row on first signup" and listed in
 * issue #248's acceptance criteria.
 *
 * The handler still adds the user to the `member` group first; the User
 * row write is a separate step so a User-row failure does not block
 * group membership.
 */
describe('postConfirmation handler — User row creation (issue #248)', () => {
  let stub: ReturnType<typeof makeStubDataClient>;

  beforeEach(() => {
    cognitoMock.reset();
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    stub = makeStubDataClient();
    __setDataDeps({ client: stub.client });
  });

  afterAll(() => {
    __resetDataDeps();
  });

  it('creates a User row keyed on the Cognito sub from userAttributes', async () => {
    const event = makeEvent({
      userName: 'cognito-user-name',
      request: {
        userAttributes: {
          sub: 'cognito-sub-aaa',
          email: 'fresh@example.com',
          email_verified: 'true',
        },
      },
    });

    await handler(event, {} as Context, () => undefined);

    expect(stub.createSpy).toHaveBeenCalledOnce();
    const input = stub.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.cognitoSub).toBe('cognito-sub-aaa');
    expect(input.email).toBe('fresh@example.com');
  });

  it('sets claimStatus=FRESH_SIGNUP and piiBlanked=false on the new row', async () => {
    const event = makeEvent({
      request: {
        userAttributes: { sub: 'cognito-sub-bbb', email: 'b@example.com' },
      },
    });

    await handler(event, {} as Context, () => undefined);

    const input = stub.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.claimStatus).toBe('FRESH_SIGNUP');
    expect(input.piiBlanked).toBe(false);
  });

  it('skips User row creation on ConfirmForgotPassword (existing user; row already exists)', async () => {
    const event = makeEvent({ triggerSource: 'PostConfirmation_ConfirmForgotPassword' });

    await handler(event, {} as Context, () => undefined);

    expect(stub.createSpy).not.toHaveBeenCalled();
  });

  it('still adds the user to the member group even when the User row write fails', async () => {
    // CLAUDE.md: "30-minute SLA is real — pipeline must support retrieval/retry".
    // A DDB hiccup on the User-row write must not break group membership;
    // the row can always be reconciled later. We swallow the data-client
    // error and log it, but the group-add side must already have run by
    // then.
    stub.createSpy.mockImplementationOnce(() =>
      Promise.resolve({ data: null, errors: [{ message: 'DDB throttled' }] }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const event = makeEvent();
    await handler(event, {} as Context, () => undefined);

    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('bails on User.create when the legacyEmail lookup throws (review fix — #248)', async () => {
    // Reviewer flagged that a transient DDB throttle / ECONNRESET on the
    // legacyEmail lookup used to fall through to `User.create`, which
    // could duplicate a legacy row that actually exists. The handler
    // now bails so Cognito's at-least-once retry resolves it on the
    // next call. Group-add already happened, so sign-in continues to
    // work.
    stub.listByEmailSpy.mockImplementationOnce(() => Promise.reject(new Error('DDB throttled')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const event = makeEvent({
      request: {
        userAttributes: { sub: 'cognito-sub-ccc', email: 'maybe-legacy@example.com' },
      },
    });
    await handler(event, {} as Context, () => undefined);

    expect(stub.createSpy).not.toHaveBeenCalled();
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('dispatches the legacy-claim worker (async, fire-and-forget) and does not create a fresh row', async () => {
    // Sub-A of #16 (#272): on a legacy-email match, postConfirmation
    // async-invokes `legacyClaimWorker` and returns. The PK rewrite
    // happens off the sign-up hot path so the user does not wait on
    // the DDB transact + audit write.
    stub = makeStubDataClient({
      existingByEmail: {
        cognitoSub: 'legacy:42',
        email: null,
        legacyEmail: 'reclaim@example.com',
        legacyUserId: 42,
        claimStatus: 'PENDING_CLAIM',
      },
    });
    __setDataDeps({ client: stub.client });

    const dispatchSpy = vi.fn<(p: LegacyClaimDispatchPayload) => Promise<void>>(() =>
      Promise.resolve(),
    );
    __setLegacyClaimDispatcher(dispatchSpy);

    const event = makeEvent({
      request: {
        userAttributes: { sub: 'cognito-sub-real-42', email: 'reclaim@example.com' },
      },
    });
    await handler(event, {} as Context, () => undefined);

    expect(stub.createSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledOnce();
    const payload = dispatchSpy.mock.calls[0]?.[0];
    expect(payload?.realSub).toBe('cognito-sub-real-42');
    expect(payload?.email).toBe('reclaim@example.com');

    __setLegacyClaimDispatcher(undefined);
  });

  it('does not rethrow when the legacy-claim dispatcher fails (sign-up must complete)', async () => {
    // Cognito's PostConfirmation trigger is synchronous — a rethrow here
    // would surface to the user as a failed sign-up. The dispatch is
    // best-effort; PR-C's replay sweep picks up unclaimed rows.
    stub = makeStubDataClient({
      existingByEmail: {
        cognitoSub: 'legacy:99',
        email: null,
        legacyEmail: 'r@example.com',
        legacyUserId: 99,
        claimStatus: 'PENDING_CLAIM',
      },
    });
    __setDataDeps({ client: stub.client });

    const dispatchSpy = vi.fn<(p: LegacyClaimDispatchPayload) => Promise<void>>(() =>
      Promise.reject(new Error('Lambda invoke failed')),
    );
    __setLegacyClaimDispatcher(dispatchSpy);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const event = makeEvent({
      request: {
        userAttributes: { sub: 'cognito-sub-99', email: 'r@example.com' },
      },
    });
    await expect(handler(event, {} as Context, () => undefined)).resolves.toBeDefined();

    expect(stub.createSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    __setLegacyClaimDispatcher(undefined);
  });
});
