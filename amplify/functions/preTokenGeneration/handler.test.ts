import { describe, it, expect } from 'vitest';
import type { Context, PreTokenGenerationTriggerEvent } from 'aws-lambda';
import { handler } from './handler';

/**
 * preTokenGeneration handler contract (#334 → patched by #420).
 *
 * Cognito fires this trigger on every token issuance — sign-in,
 * refresh, hosted UI, federated callback. The handler injects two
 * claims into the ID token via `response.claimsOverrideDetails`:
 *
 *   - `custom:role` — highest of the user's Cognito groups
 *     (admin > moderator > member; defaults to "member" when the
 *     groupConfiguration is empty).
 *   - `custom:repWeight` — always emitted as "1" in this build. The
 *     real Reputation lookup was removed in #420 because the direct
 *     DDB read in the `auth` nested stack closed a CFN cycle with
 *     `data` and broke every Amplify deploy. The frontend contract
 *     is unchanged; the value just isn't authoritative until the
 *     proper repWeight pipeline lands (tracked separately).
 *
 * Failure mode: `sub` missing → handler returns the event untouched.
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
    callerContext: {
      awsSdkVersion: 'aws-sdk-unknown-unknown',
      clientId: 'client-test',
    },
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

describe('preTokenGeneration — role derivation', () => {
  it('emits custom:role = admin when the user is in the admin group', async () => {
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member', 'admin'] }));
    expect(out.role).toBe('admin');
  });

  it('emits custom:role = moderator when in moderator but not admin', async () => {
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['moderator', 'member'] }));
    expect(out.role).toBe('moderator');
  });

  it('emits custom:role = member by default (single group)', async () => {
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member'] }));
    expect(out.role).toBe('member');
  });

  it('emits custom:role = member when groupConfiguration is empty', async () => {
    // Defensive: federated first sign-in can hit the trigger before
    // postConfirmation runs the group-add. "member" is the safe default.
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: [] }));
    expect(out.role).toBe('member');
  });

  it('ignores unrecognised group names when picking the highest role', async () => {
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member', 'beta-tester'] }));
    expect(out.role).toBe('member');
  });
});

describe('preTokenGeneration — reputation weight (placeholder until #420 follow-up)', () => {
  it('always emits custom:repWeight = "1"', async () => {
    const out = await runHandler(buildEvent({ sub: 'sub-rep', groups: ['member'] }));
    expect(out.repWeight).toBe('1');
  });

  it('emits the placeholder for admin too — role and rep are independent', async () => {
    const out = await runHandler(buildEvent({ sub: 'sub-admin', groups: ['admin'] }));
    expect(out.repWeight).toBe('1');
    expect(out.role).toBe('admin');
  });
});

describe('preTokenGeneration — missing sub', () => {
  it('returns the event unchanged when sub is missing', async () => {
    const out = await runHandler(buildEvent({ sub: undefined, groups: ['member'] }));
    // No sub means no targeted action — handler should leave
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
    const out = await runHandler(buildEvent({ sub: 'sub-1', groups: ['member'], triggerSource }));
    expect(out.role).toBe('member');
    expect(out.repWeight).toBe('1');
  });
});
