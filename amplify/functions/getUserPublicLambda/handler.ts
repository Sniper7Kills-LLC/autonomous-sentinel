import type { AppSyncResolverHandler } from 'aws-lambda';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * `getUserPublic` Lambda (#271) — PII-filtered User lookup.
 *
 * Replaces the original `a.handler.custom` JS resolver that PR #269
 * had to lock down to `allow.authenticated()` only. Amplify Gen 2
 * rejects `allow.guest()` on custom JS resolvers under the
 * `identityPool` default auth mode; a Lambda-backed function isn't
 * subject to that limitation, so guest profile browse is restored.
 *
 * Behaviour matches the prior JS resolver:
 *   - GetItem on User by `cognitoSub`.
 *   - If the row is missing → return null.
 *   - If `piiBlanked=true` and the caller is NOT in the `admin`
 *     Cognito group → blank `email` / `preferredUsername` /
 *     `displayName` on the returned payload (the underlying row
 *     keeps the values for audit purposes).
 *   - Admin callers always see the un-filtered row, including the
 *     blanked-but-retained values.
 *
 * Dependency-injected: tests stub `getUserByCognitoSub`. Production
 * uses the shared DDB client from `fan-out-production` so cold-start
 * instances reuse the SDK client across invocations.
 */

export type UserRow = {
  cognitoSub: string;
  email?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  piiBlanked?: boolean | null;
  [k: string]: unknown;
};

export interface GetUserPublicDeps {
  getUserByCognitoSub: (cognitoSub: string) => Promise<UserRow | null>;
}

let injected: Partial<GetUserPublicDeps> = {};

export function __setDeps(deps: Partial<GetUserPublicDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

function defaultUserTableName(): string {
  const v = process.env.USER_TABLE_NAME;
  if (!v) {
    throw new Error('getUserPublicLambda: USER_TABLE_NAME env var is required');
  }
  return v;
}

async function defaultGetUserByCognitoSub(cognitoSub: string): Promise<UserRow | null> {
  const res = await getDdbClient().send(
    new GetItemCommand({
      TableName: defaultUserTableName(),
      Key: marshall({ cognitoSub }),
    }),
  );
  return res.Item ? (unmarshall(res.Item) as UserRow) : null;
}

function resolveDeps(): GetUserPublicDeps {
  return {
    getUserByCognitoSub: injected.getUserByCognitoSub ?? defaultGetUserByCognitoSub,
  };
}

const PII_FIELDS = ['email', 'preferredUsername', 'displayName'] as const;
const ADMIN_GROUP = 'admin';

function isAdmin(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf(ADMIN_GROUP) >= 0;
}

export const handler: AppSyncResolverHandler<{ cognitoSub: string }, UserRow | null> = async (
  event,
) => {
  const { cognitoSub } = event.arguments;
  if (!cognitoSub || cognitoSub.trim() === '') {
    throw new Error('getUserPublic: cognitoSub argument is required');
  }

  const deps = resolveDeps();
  const row = await deps.getUserByCognitoSub(cognitoSub);
  if (row === null) {
    return null;
  }

  if (isAdmin(event.identity)) {
    return row;
  }
  if (!row.piiBlanked) {
    return row;
  }

  // PII-blanked + non-admin caller → null out the protected fields.
  const filtered: UserRow = { ...row };
  for (const field of PII_FIELDS) {
    filtered[field] = null;
  }
  return filtered;
};
