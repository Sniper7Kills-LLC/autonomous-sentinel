import { describe, it, expect, afterEach } from 'vitest';
import type { Context, PreAuthenticationTriggerEvent } from 'aws-lambda';
import { handler, __setDeps, __resetDeps, BAN_REJECTION_MESSAGE } from './handler';

/**
 * preAuthentication handler contract (#335).
 *
 * Cognito fires this trigger before native username/password sign-in
 * succeeds. Throwing in here causes Cognito to fail the auth with a
 * `NotAuthorizedException`, so a banned user can never trade their
 * credentials for tokens via the native auth flow.
 *
 * Federated providers (Google + Discord OIDC bridge) bypass PreAuth —
 * Cognito treats them as already-authenticated. That gap is tracked
 * separately; this Lambda is the native sign-in block specified by
 * #335.
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
    callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: 'client-test' },
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

afterEach(() => __resetDeps());

describe('preAuthentication — ban check', () => {
  it('rejects sign-in when User.bannedAt is set', async () => {
    __setDeps({
      getUser: () =>
        Promise.resolve({
          cognitoSub: 'sub-banned',
          bannedAt: '2026-01-15T12:00:00Z',
          bannedReason: 'spam',
        }),
    });
    const event = buildEvent({ sub: 'sub-banned', email: 'banned@example.com' });
    await expect(handler(event, FAKE_CTX, NOOP_CALLBACK)).rejects.toThrow(BAN_REJECTION_MESSAGE);
  });

  it('allows sign-in when User row exists with no ban', async () => {
    __setDeps({
      getUser: () => Promise.resolve({ cognitoSub: 'sub-ok', bannedAt: null, bannedReason: null }),
    });
    const event = buildEvent({ sub: 'sub-ok' });
    const result = (await handler(event, FAKE_CTX, NOOP_CALLBACK)) as PreAuthenticationTriggerEvent;
    expect(result).toEqual(event);
  });

  it('allows sign-in when User row is missing (fresh signup mid-flow)', async () => {
    // The post-confirmation Lambda lazily creates the User shadow row
    // after Cognito-side signup completes. A native sign-in trigger
    // could fire before that row lands; missing row ≠ banned.
    __setDeps({ getUser: () => Promise.resolve(null) });
    const event = buildEvent({ sub: 'sub-missing' });
    const result = (await handler(event, FAKE_CTX, NOOP_CALLBACK)) as PreAuthenticationTriggerEvent;
    expect(result).toEqual(event);
  });

  it('passes the cognito sub from userAttributes.sub to the lookup', async () => {
    let receivedSub: string | undefined;
    __setDeps({
      getUser: (sub) => {
        receivedSub = sub;
        return Promise.resolve(null);
      },
    });
    const event = buildEvent({ sub: 'sub-target' });
    await handler(event, FAKE_CTX, NOOP_CALLBACK);
    expect(receivedSub).toBe('sub-target');
  });
});

describe('preAuthentication — defensive paths', () => {
  it('allows sign-in when Cognito flags userNotFound (Cognito will fail the auth itself)', async () => {
    // Defensive: PreAuth fires even for nonexistent users in some
    // configurations. The Cognito layer already returns the right
    // error in that case — adding our own throw is redundant.
    let lookupCalled = false;
    __setDeps({
      getUser: () => {
        lookupCalled = true;
        return Promise.resolve(null);
      },
    });
    const event = buildEvent({ userNotFound: true });
    const result = (await handler(event, FAKE_CTX, NOOP_CALLBACK)) as PreAuthenticationTriggerEvent;
    expect(result).toEqual(event);
    expect(lookupCalled).toBe(false);
  });

  it('allows sign-in when sub is missing from userAttributes (Cognito edge case)', async () => {
    let lookupCalled = false;
    __setDeps({
      getUser: () => {
        lookupCalled = true;
        return Promise.resolve(null);
      },
    });
    const event = buildEvent({ sub: undefined });
    const result = (await handler(event, FAKE_CTX, NOOP_CALLBACK)) as PreAuthenticationTriggerEvent;
    expect(result).toEqual(event);
    expect(lookupCalled).toBe(false);
  });

  it('FAILS-CLOSED on a DDB lookup error — blocks sign-in rather than risk letting a banned user in', async () => {
    // Diverges from the preTokenGeneration fail-OPEN policy (#334) on
    // purpose. preTokenGeneration is best-effort claim enrichment;
    // PreAuth is a hard security gate. Letting a transient DDB blip
    // grant access to a possibly-banned user is the wrong default.
    // Cognito retries the trigger, so a flaky lookup will recover on
    // its own; the legitimate-user UX cost is acceptable.
    __setDeps({
      getUser: () => Promise.reject(new Error('boom')),
    });
    const event = buildEvent({ sub: 'sub-err' });
    await expect(handler(event, FAKE_CTX, NOOP_CALLBACK)).rejects.toThrow();
  });
});
