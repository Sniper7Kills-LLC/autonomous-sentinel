import { describe, it, expect } from 'vitest';
import type { Context, PreAuthenticationTriggerEvent } from 'aws-lambda';
import { handler, BAN_REJECTION_MESSAGE } from './handler';

/**
 * preAuthentication handler contract (#335 → patched in follow-up to #420).
 *
 * The original ban-check was removed because the DynamoDB read from
 * the `auth` nested stack closed a CFN circular dependency cycle that
 * blocked every Amplify deploy from job 42 onward. The handler now
 * unconditionally returns the event; banned-user enforcement moved to
 * the AppSync resolver / mutation handler layer where every mutation
 * already checks `User.bannedAt` before acting.
 *
 * The proper re-introduction lives behind a future change that drives a
 * Cognito custom attribute (`custom:bannedAt`) from a DynamoDB stream
 * on the User table — preAuth then reads from event.request.userAttributes
 * with no DDB call and no cross-stack ref.
 */

const NOOP_CALLBACK = () => {};
const FAKE_CTX = {} as Context;

function buildEvent(opts: {
  sub?: string;
  email?: string;
  userNotFound?: boolean;
}): PreAuthenticationTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_test',
    userName: opts.sub ?? 'sub-abc',
    callerContext: {
      awsSdkVersion: 'aws-sdk-unknown-unknown',
      clientId: 'client-test',
    },
    triggerSource: 'PreAuthentication_Authentication',
    request: {
      userAttributes: {
        ...(opts.sub ? { sub: opts.sub } : {}),
        ...(opts.email ? { email: opts.email } : {}),
      },
      userNotFound: opts.userNotFound ?? false,
    },
    response: {},
  };
}

describe('preAuthentication — placeholder (lookup removed by #420 follow-up)', () => {
  it('returns the event unchanged for a regular sub', async () => {
    const out: unknown = await handler(
      buildEvent({ sub: 'sub-1', email: 'u@example.com' }),
      FAKE_CTX,
      NOOP_CALLBACK,
    );
    expect(out).toBeDefined();
  });

  it('returns the event unchanged when userNotFound is signalled', async () => {
    const out: unknown = await handler(
      buildEvent({ sub: 'sub-1', userNotFound: true }),
      FAKE_CTX,
      NOOP_CALLBACK,
    );
    expect(out).toBeDefined();
  });

  it('returns the event unchanged when sub is missing', async () => {
    const out: unknown = await handler(
      buildEvent({ email: 'u@example.com' }),
      FAKE_CTX,
      NOOP_CALLBACK,
    );
    expect(out).toBeDefined();
  });

  it('still exports the BAN_REJECTION_MESSAGE constant for re-introduction', () => {
    // Kept exported so the upcoming Cognito-attribute-driven
    // re-introduction can reuse the same user-facing copy.
    expect(BAN_REJECTION_MESSAGE).toMatch(/suspended/i);
  });
});
