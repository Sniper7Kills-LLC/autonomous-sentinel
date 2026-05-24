import type { PreAuthenticationTriggerHandler } from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * Cognito Pre-Authentication trigger (#335).
 *
 * Fires before native username/password sign-in completes. If the
 * caller's User row carries a `bannedAt` timestamp, the handler
 * throws — Cognito returns `NotAuthorizedException` and the
 * credentials never trade for tokens.
 *
 * Federation gap: PreAuth does NOT fire for Google + Discord OIDC
 * sign-ins — Cognito treats federated identities as already
 * authenticated upstream. The federated-side ban check is a separate
 * follow-up; this Lambda is the native-flow gate specified by #335.
 *
 * Security policy — **fail-CLOSED on DDB errors**. Intentionally
 * diverges from `preTokenGeneration` (#334) which fails open for
 * Reputation lookup. PreAuth is a hard security gate; granting access
 * to a possibly-banned user on a transient DDB blip is the wrong
 * default. Cognito retries the trigger, so a flaky lookup recovers on
 * its own; the legitimate-user UX cost is bounded and acceptable.
 */

export const BAN_REJECTION_MESSAGE =
  'Account suspended. Contact support if you believe this is in error.';

export interface UserBanRow {
  cognitoSub: string;
  bannedAt?: string | null;
  bannedReason?: string | null;
  [k: string]: unknown;
}

export interface PreAuthDeps {
  getUser: (cognitoSub: string) => Promise<UserBanRow | null>;
}

let injected: Partial<PreAuthDeps> = {};

export function __setDeps(deps: Partial<PreAuthDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

function userTableName(): string {
  const v = process.env.USER_TABLE_NAME;
  if (!v) {
    throw new Error('preAuth: USER_TABLE_NAME env var is required');
  }
  return v;
}

async function defaultGetUser(cognitoSub: string): Promise<UserBanRow | null> {
  const res = await getDdbClient().send(
    new GetItemCommand({
      TableName: userTableName(),
      Key: marshall({ cognitoSub }),
    }),
  );
  return res.Item ? (unmarshall(res.Item) as UserBanRow) : null;
}

function resolveDeps(): PreAuthDeps {
  return { getUser: injected.getUser ?? defaultGetUser };
}

export const handler: PreAuthenticationTriggerHandler = async (event, _context, _callback) => {
  // Defensive short-circuits: don't lookup if Cognito already
  // signalled there's nothing to look up.
  if (event.request.userNotFound) {
    return event;
  }
  const sub = event.request.userAttributes?.sub;
  if (!sub) {
    return event;
  }

  const user = await resolveDeps().getUser(sub);
  if (user && user.bannedAt) {
    console.warn('preAuth: rejecting banned user sign-in', {
      cognitoSub: sub,
      bannedAt: user.bannedAt,
      bannedReason: user.bannedReason ?? null,
    });
    throw new Error(BAN_REJECTION_MESSAGE);
  }
  return event;
};
