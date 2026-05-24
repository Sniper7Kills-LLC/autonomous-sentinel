import type { PreTokenGenerationTriggerHandler } from 'aws-lambda';

/**
 * Cognito Pre-Token-Generation trigger (#334).
 *
 * Fires on every token issuance — sign-in, refresh, hosted UI redirect,
 * federated callback. Injects two custom claims into the ID token:
 *
 *   - `custom:role`      — highest of admin > moderator > member,
 *     derived from `event.request.groupConfiguration.groupsToOverride`.
 *     Defaults to "member" when groups are empty (federated first
 *     sign-in can hit this trigger before postConfirmation runs the
 *     group-add).
 *   - `custom:repWeight` — always emitted as `"1"` for now. **The real
 *     `Reputation.computedWeight` lookup is intentionally disabled
 *     here** because reading the Reputation DynamoDB table directly
 *     from this Lambda (which lives in the `auth` nested stack)
 *     creates a CloudFormation cross-stack ref to `data`, closing a
 *     cycle with the existing `data → auth` (AppSync auth mode +
 *     Identity Pool) and `storage → auth` edges. That cycle broke
 *     every Amplify Hosting deploy from job 42 onward — see #420.
 *
 *     The frontend contract still includes `custom:repWeight` so no
 *     client code needs to change; it just always reads `1` until the
 *     proper re-introduction (DDB-stream → Cognito custom attribute,
 *     or equivalent) lands. The authoritative weight remains on the
 *     `Reputation` row itself for backend authorization checks.
 *
 * Token-version note: this uses the V1 trigger event shape, which
 * injects claims into the ID token only. AppSync userPool auth + the
 * Amplify client both consume the ID token, so V1 is sufficient at
 * v1. Bump to V2_0 (`claimsAndScopeOverrideDetails`) when access-token
 * claim injection becomes a real requirement (e.g. for direct IAM
 * authorizer use). The contract test pins the V1 response shape.
 */

const KNOWN_ROLES = ['admin', 'moderator', 'member'] as const;
type KnownRole = (typeof KNOWN_ROLES)[number];
const DEFAULT_ROLE: KnownRole = 'member';
const DEFAULT_REP_WEIGHT_CLAIM = '1';

function pickHighestRole(groups: readonly string[]): KnownRole {
  // Iterate KNOWN_ROLES in priority order so the first match wins.
  for (const role of KNOWN_ROLES) {
    if (groups.indexOf(role) >= 0) return role;
  }
  return DEFAULT_ROLE;
}

export const handler: PreTokenGenerationTriggerHandler = (event, _context, _callback) => {
  const sub = event.request.userAttributes?.sub;
  if (!sub) {
    // Defensive: every Cognito token-generation event includes the sub,
    // but if a future runtime change ever omits it we return the event
    // untouched rather than guess a target for the lookup.
    console.warn('preTokenGeneration: missing sub in userAttributes — returning event unchanged');
    return Promise.resolve(event);
  }

  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const role = pickHighestRole(groups);

  event.response.claimsOverrideDetails = {
    ...(event.response.claimsOverrideDetails ?? {}),
    claimsToAddOrOverride: {
      ...(event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {}),
      'custom:role': role,
      'custom:repWeight': DEFAULT_REP_WEIGHT_CLAIM,
    },
  };
  return Promise.resolve(event);
};
