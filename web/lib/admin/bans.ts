'use client';

import { getDataClient } from '@/lib/amplifyClient';

/**
 * Admin user-ban management data layer (#112, Users tab).
 *
 * Backs the `/admin/bans` Users tab: list currently-banned User rows, ban
 * a user (by email lookup → `banUser`), and lift a ban (`unbanUser`). All
 * calls use the `userPool` auth mode — User reads + the ban mutations are
 * admin-only grants honoured via the JWT group claim; the server enforces
 * authorization, this layer only assembles data.
 *
 * IP-CIDR + country ban tabs are deliberately out of scope here — they
 * depend on the AWS WAF rulesets (#199 / #200), not yet built.
 */

const USER_POOL = { authMode: 'userPool' as const };

export interface BannedUser {
  cognitoSub: string;
  email: string | null;
  displayName: string | null;
  bannedAt: string | null;
  bannedReason: string | null;
  bannedById: string | null;
}

type RawUser = {
  cognitoSub: string;
  email?: string | null;
  displayName?: string | null;
  bannedAt?: string | null;
  bannedReason?: string | null;
  bannedById?: string | null;
};

type RawList = {
  data?: RawUser[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};
type RawOne = { data?: RawUser | null; errors?: { message: string }[] | null };

export function toBannedUser(r: RawUser): BannedUser {
  return {
    cognitoSub: r.cognitoSub,
    email: r.email ?? null,
    displayName: r.displayName ?? null,
    bannedAt: r.bannedAt ?? null,
    bannedReason: r.bannedReason ?? null,
    bannedById: r.bannedById ?? null,
  };
}

function throwOnErrors(res: { errors?: { message: string }[] | null }): void {
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
}

/**
 * List every currently-banned user (rows where `bannedAt` is set). Uses a
 * filtered `list` (scan-filter) — the banned set is small, so this is
 * acceptable; switch to the `bannedAt` GSI if it ever grows large.
 */
export async function listBannedUsers(): Promise<BannedUser[]> {
  const client = getDataClient();
  const listFn = client.models.User.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawList>;
  const out: BannedUser[] = [];
  let nextToken: string | null | undefined;
  do {
    const raw = await listFn({
      filter: { bannedAt: { attributeExists: true } },
      limit: 1000,
      nextToken: nextToken ?? undefined,
      ...USER_POOL,
    });
    throwOnErrors(raw);
    for (const r of raw.data ?? []) out.push(toBannedUser(r));
    nextToken = raw.nextToken;
  } while (nextToken);
  // Most-recently banned first.
  return out.sort((a, b) => (b.bannedAt ?? '').localeCompare(a.bannedAt ?? ''));
}

/** Resolve a Cognito sub from an email via the User `email` GSI. */
export async function findUserSubByEmail(email: string): Promise<string | null> {
  const client = getDataClient();
  const byEmail = (
    client.queries as unknown as {
      listUserByEmail?: (input: { email: string }, opts: typeof USER_POOL) => Promise<RawList>;
    }
  ).listUserByEmail;
  // The generated GSI query is `listUserByEmail` when available; fall back
  // to a filtered list otherwise.
  if (byEmail) {
    const raw = await byEmail({ email }, USER_POOL);
    throwOnErrors(raw);
    return raw.data?.[0]?.cognitoSub ?? null;
  }
  const listFn = client.models.User.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawList>;
  const raw = await listFn({ filter: { email: { eq: email } }, limit: 1, ...USER_POOL });
  throwOnErrors(raw);
  return raw.data?.[0]?.cognitoSub ?? null;
}

/** Ban a user by Cognito sub. */
export async function banUserBySub(targetCognitoSub: string, reason: string): Promise<void> {
  const client = getDataClient();
  const fn = client.mutations.banUser as unknown as (
    input: { targetCognitoSub: string; reason?: string },
    opts: typeof USER_POOL,
  ) => Promise<RawOne>;
  const res = await fn({ targetCognitoSub, reason }, USER_POOL);
  throwOnErrors(res);
}

/** Lift a user's ban by Cognito sub. */
export async function unbanUserBySub(targetCognitoSub: string, reason: string): Promise<void> {
  const client = getDataClient();
  const fn = client.mutations.unbanUser as unknown as (
    input: { targetCognitoSub: string; reason?: string },
    opts: typeof USER_POOL,
  ) => Promise<RawOne>;
  const res = await fn({ targetCognitoSub, reason }, USER_POOL);
  throwOnErrors(res);
}
