import { describe, it, expect, afterEach } from 'vitest';
import type { Context, PreTokenGenerationTriggerEvent } from 'aws-lambda';
import { handler, __setDeps, __resetDeps } from './handler';

/**
 * preTokenGeneration handler contract (#334).
 *
 * Cognito fires this trigger on every token issuance — sign-in,
 * refresh, hosted UI, federated callback. The handler injects two
 * claims into the ID token via `response.claimsOverrideDetails`:
 *
 *   - `custom:role` — highest of the user's Cognito groups
 *     (admin > moderator > member; defaults to "member" when the
 *     groupConfiguration is empty).
 *   - `custom:repWeight` — `Reputation.computedWeight` for the user.
 *     Default value when the row is missing is "1" so the frontend
 *     doesn't have to special-case the lazy-create window between
 *     postConfirmation and the row landing.
 *
 * Failure mode is fail-open: a DDB error logs and returns the event
 * with the role claim and a default rep weight so a transient blip
 * never blocks a sign-in or refresh.
 */

const NOOP_CALLBACK = () => {};
const FAKE_CTX = {} as Context;

function buildEvent(opts: {
  sub?: string;
  groups?: readonly string[];
  triggerSource?: PreTokenGenerationTriggerEvent['triggerSource'];
}): PreTokenGenerationTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_test',
    userName: opts.sub ?? 'sub-abc',
    callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: 'client-test' },
    triggerSource: opts.triggerSource ?? 'TokenGeneration_Authentication',
    request: {
      userAttributes: opts.sub ? { sub: opts.sub, email: 'u@example.com' } : {},
      groupConfiguration: {
        groupsToOverride: opts.groups ? [...opts.groups] : [],
        iamRolesToOverride: [],
        preferredRole: undefined,
      },
    },
    response: { claimsOverrideDetails: {} },
  };
}

async function runHandler(event: PreTokenGenerationTriggerEvent): Promise<{
  role: string | undefined;
  repWeight: string | undefined;
  rawClaims: Record<string, string> | undefined;
}> {
  const result = (await handler(event, FAKE_CTX, NOOP_CALLBACK)) as
    | PreTokenGenerationTriggerEvent
    | undefined;
  const claims = result?.response.claimsOverrideDetails?.claimsToAddOrOverride;
  return {
    role: claims?.['custom:role'],
    repWeight: claims?.['custom:repWeight'],
    rawClaims: claims,
  };
}

afterEach(() => __resetDeps());

describe('preTokenGeneration — role derivation', () => {
  it('emits custom:role = admin when the user is in the admin group', async () => {
    __setDeps({ getReputationWeight: () => Promise.resolve(1.0) });
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member', 'admin'] }));
    expect(out.role).toBe('admin');
  });

  it('emits custom:role = moderator when in moderator but not admin', async () => {
    __setDeps({ getReputationWeight: () => Promise.resolve(1.0) });
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['moderator', 'member'] }));
    expect(out.role).toBe('moderator');
  });

  it('emits custom:role = member by default (single group)', async () => {
    __setDeps({ getReputationWeight: () => Promise.resolve(1.0) });
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member'] }));
    expect(out.role).toBe('member');
  });

  it('emits custom:role = member when groupConfiguration is empty', async () => {
    // Defensive: federated first sign-in can hit the trigger before
    // postConfirmation runs the group-add. "member" is the safe default.
    __setDeps({ getReputationWeight: () => Promise.resolve(1.0) });
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: [] }));
    expect(out.role).toBe('member');
  });

  it('ignores unrecognised group names when picking the highest role', async () => {
    __setDeps({ getReputationWeight: () => Promise.resolve(1.0) });
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member', 'beta-tester'] }));
    expect(out.role).toBe('member');
  });
});

describe('preTokenGeneration — reputation weight', () => {
  it('emits custom:repWeight from the Reputation lookup', async () => {
    __setDeps({ getReputationWeight: () => Promise.resolve(3.7) });
    const out = await runHandler(buildEvent({ sub: 'sub-rep', groups: ['member'] }));
    expect(out.repWeight).toBe('3.7');
  });

  it('passes the cognito sub from event.request.userAttributes.sub to the lookup', async () => {
    let receivedUserId: string | undefined;
    __setDeps({
      getReputationWeight: (userId) => {
        receivedUserId = userId;
        return Promise.resolve(1);
      },
    });
    await runHandler(buildEvent({ sub: 'sub-target', groups: ['member'] }));
    expect(receivedUserId).toBe('sub-target');
  });

  it('defaults custom:repWeight to "1" when the Reputation row is missing', async () => {
    // Lazy-create window between postConfirmation and the actual row
    // write. Frontend reads "1" as the baseline weight per the
    // Reputation model default; no special handling required.
    __setDeps({ getReputationWeight: () => Promise.resolve(null) });
    const out = await runHandler(buildEvent({ sub: 'sub-missing', groups: ['member'] }));
    expect(out.repWeight).toBe('1');
  });

  it('serialises the weight as a string (Cognito claims values must be strings)', async () => {
    __setDeps({ getReputationWeight: () => Promise.resolve(2.0) });
    const out = await runHandler(buildEvent({ sub: 'sub-num', groups: ['member'] }));
    expect(typeof out.repWeight).toBe('string');
  });

  it('rounds the weight to 2 decimal places to drop IEEE-754 stringification noise', async () => {
    // `String(0.1 + 0.2)` yields "0.30000000000000004" — leaking that
    // into a JWT claim is ugly + would break exact-string comparisons
    // by any consumer. Rep weights are in [1, 5] by the formula; 2 dp
    // is plenty.
    __setDeps({ getReputationWeight: () => Promise.resolve(0.1 + 0.2) });
    const out = await runHandler(buildEvent({ sub: 'sub-fp', groups: ['member'] }));
    expect(out.repWeight).toBe('0.3');
  });
});

describe('preTokenGeneration — fail-open semantics', () => {
  it('fails open when the Reputation lookup throws — role claim still lands, rep defaults to "1"', async () => {
    // DDB throttle / ECONNRESET must not block sign-in. Cognito retries
    // do nothing useful here (the user already authenticated upstream);
    // returning the event with the role claim is the safe outcome.
    __setDeps({
      getReputationWeight: () => Promise.reject(new Error('boom')),
    });
    const out = await runHandler(buildEvent({ sub: 'sub-err', groups: ['moderator'] }));
    expect(out.role).toBe('moderator');
    expect(out.repWeight).toBe('1');
  });

  it('returns the event unchanged when sub is missing — nothing to look up', async () => {
    __setDeps({ getReputationWeight: () => Promise.resolve(5) });
    const out = await runHandler(buildEvent({ sub: undefined, groups: ['member'] }));
    // No sub means no targeted lookup — handler should leave
    // claimsOverrideDetails empty rather than guess.
    expect(out.rawClaims).toBeUndefined();
  });
});

describe('preTokenGeneration — trigger source coverage', () => {
  it.each([
    'TokenGeneration_HostedAuth',
    'TokenGeneration_Authentication',
    'TokenGeneration_NewPasswordChallenge',
    'TokenGeneration_AuthenticateDevice',
    'TokenGeneration_RefreshTokens',
  ] as const)('injects claims on %s', async (triggerSource) => {
    __setDeps({ getReputationWeight: () => Promise.resolve(1) });
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member'], triggerSource }));
    expect(out.role).toBe('member');
    expect(out.repWeight).toBe('1');
  });
});
