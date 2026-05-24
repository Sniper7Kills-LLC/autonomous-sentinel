import type { PreTokenGenerationTriggerHandler } from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * Cognito Pre-Token-Generation trigger (#334).
 *
 * Fires on every token issuance — sign-in, refresh, hosted UI redirect,
 * federated callback. Injects two custom claims into the ID token so
 * the frontend + AppSync resolvers can read role + vote-weight without
 * a DDB round-trip per request:
 *
 *   - `custom:role`      — highest of admin > moderator > member,
 *     derived from `event.request.groupConfiguration.groupsToOverride`.
 *     Defaults to "member" when groups are empty (federated first
 *     sign-in can hit this trigger before postConfirmation runs the
 *     group-add).
 *   - `custom:repWeight` — `Reputation.computedWeight` for the caller.
 *     Defaults to "1" when the row is missing (lazy-create window
 *     between postConfirmation and the actual row write) so the
 *     frontend never reads a missing claim.
 *
 * Token-version note: this uses the V1 trigger event shape, which
 * injects claims into the ID token only. AppSync userPool auth + the
 * Amplify client both consume the ID token, so V1 is sufficient at
 * v1. Bump to V2_0 (`claimsAndScopeOverrideDetails`) when access-token
 * claim injection becomes a real requirement (e.g. for direct IAM
 * authorizer use). The contract test pins the V1 response shape.
 *
 * Fail-open: a DDB error logs and returns the role claim with
 * `custom:repWeight = "1"`. A transient lookup blip must never block
 * sign-in — Cognito retries are useless here (the upstream
 * authentication already succeeded) and a refresh from the client will
 * pick up the real value on its next call.
 */

const KNOWN_ROLES = ['admin', 'moderator', 'member'] as const;
type KnownRole = (typeof KNOWN_ROLES)[number];
const DEFAULT_ROLE: KnownRole = 'member';
const DEFAULT_REP_WEIGHT_CLAIM = '1';

export interface PreTokenGenerationDeps {
  getReputationWeight: (userId: string) => Promise<number | null>;
}

let injected: Partial<PreTokenGenerationDeps> = {};

export function __setDeps(deps: Partial<PreTokenGenerationDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

function reputationTableName(): string {
  const v = process.env.REPUTATION_TABLE_NAME;
  if (!v) {
    throw new Error('preTokenGeneration: REPUTATION_TABLE_NAME env var is required');
  }
  return v;
}

async function defaultGetReputationWeight(userId: string): Promise<number | null> {
  const res = await getDdbClient().send(
    new GetItemCommand({
      TableName: reputationTableName(),
      Key: marshall({ userId }),
    }),
  );
  if (!res.Item) return null;
  const row = unmarshall(res.Item) as { computedWeight?: unknown };
  return typeof row.computedWeight === 'number' ? row.computedWeight : null;
}

function resolveDeps(): PreTokenGenerationDeps {
  return {
    getReputationWeight: injected.getReputationWeight ?? defaultGetReputationWeight,
  };
}

function pickHighestRole(groups: readonly string[]): KnownRole {
  // Iterate KNOWN_ROLES in priority order so the first match wins.
  for (const role of KNOWN_ROLES) {
    if (groups.indexOf(role) >= 0) return role;
  }
  return DEFAULT_ROLE;
}

/**
 * Round to 2 decimal places before stringifying so the claim does not
 * leak IEEE-754 noise (e.g. `String(0.1 + 0.2)` yields
 * "0.30000000000000004"). 2 dp is plenty for a rep weight bounded by
 * the formula at [1, 5]; trailing zeros are stripped by relying on
 * `String()` after `Math.round` so the claim still reads "3.7" not
 * "3.70".
 */
function formatRepWeightClaim(weight: number): string {
  return String(Math.round(weight * 100) / 100);
}

export const handler: PreTokenGenerationTriggerHandler = async (event) => {
  const sub = event.request.userAttributes?.sub;
  if (!sub) {
    // Defensive: every Cognito token-generation event includes the sub,
    // but if a future runtime change ever omits it we return the event
    // untouched rather than guess a target for the lookup.
    console.warn('preTokenGeneration: missing sub in userAttributes — returning event unchanged');
    return event;
  }

  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  const role = pickHighestRole(groups);

  let repWeightClaim = DEFAULT_REP_WEIGHT_CLAIM;
  try {
    const weight = await resolveDeps().getReputationWeight(sub);
    if (weight !== null) {
      repWeightClaim = formatRepWeightClaim(weight);
    }
  } catch (err) {
    // Fail-open. Log + fall through so the token still issues.
    console.error('preTokenGeneration: Reputation lookup failed — defaulting repWeight', err);
  }

  event.response.claimsOverrideDetails = {
    ...(event.response.claimsOverrideDetails ?? {}),
    claimsToAddOrOverride: {
      ...(event.response.claimsOverrideDetails?.claimsToAddOrOverride ?? {}),
      'custom:role': role,
      'custom:repWeight': repWeightClaim,
    },
  };
  return event;
};
