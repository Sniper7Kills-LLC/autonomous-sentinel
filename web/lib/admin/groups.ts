'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { findUserSubByEmail } from '@/lib/admin/bans';

/**
 * Admin user-group management data layer (#743).
 *
 * Backs the `/admin/users` group-management panel: read a user's current
 * Cognito groups (`listUserGroups`) and add/remove a group
 * (`setUserGroup`). Both calls use the `userPool` auth mode — the
 * resolvers are admin-only server-side; this layer only assembles data.
 *
 * Group membership is the `cognito:groups` authorization source of truth;
 * `setUserGroup` keeps the `User.role` mirror coherent server-side when a
 * hierarchy group (admin/moderator/member) changes. `diagnostics` is an
 * additive capability group that does not affect the role mirror.
 */

const USER_POOL = { authMode: 'userPool' as const };

/** Groups an admin may assign — mirrors the Cognito user-pool groups. */
export const ASSIGNABLE_GROUPS = ['admin', 'moderator', 'member', 'diagnostics'] as const;
export type AssignableGroup = (typeof ASSIGNABLE_GROUPS)[number];

export type GroupAction = 'add' | 'remove';

type GroupsPayload = { cognitoSub: string; groups: string[] };
type RawOne = { data?: unknown; errors?: { message: string }[] | null };

function throwOnErrors(res: { errors?: { message: string }[] | null }): void {
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
}

/**
 * Normalize the AppSync `a.json()` payload (which may arrive as an object
 * or a JSON string depending on transport) into `{ cognitoSub, groups }`.
 */
function toGroupsPayload(data: unknown): GroupsPayload {
  const parsed: unknown = typeof data === 'string' ? JSON.parse(data) : data;
  const obj = (parsed ?? {}) as { cognitoSub?: unknown; groups?: unknown };
  return {
    cognitoSub: typeof obj.cognitoSub === 'string' ? obj.cognitoSub : '',
    groups: Array.isArray(obj.groups)
      ? obj.groups.filter((g): g is string => typeof g === 'string')
      : [],
  };
}

/** Re-export so the UI can resolve email → sub without importing two modules. */
export { findUserSubByEmail };

/** Read a user's current Cognito groups by sub. */
export async function listUserGroups(targetCognitoSub: string): Promise<string[]> {
  const client = getDataClient();
  const fn = client.queries.listUserGroups as unknown as (
    input: { targetCognitoSub: string },
    opts: typeof USER_POOL,
  ) => Promise<RawOne>;
  const res = await fn({ targetCognitoSub }, USER_POOL);
  throwOnErrors(res);
  return toGroupsPayload(res.data).groups;
}

/** Add or remove a user to/from a Cognito group; returns the updated list. */
export async function setUserGroup(
  targetCognitoSub: string,
  group: AssignableGroup,
  action: GroupAction,
): Promise<string[]> {
  const client = getDataClient();
  const fn = client.mutations.setUserGroup as unknown as (
    input: { targetCognitoSub: string; group: string; action: string },
    opts: typeof USER_POOL,
  ) => Promise<RawOne>;
  const res = await fn({ targetCognitoSub, group, action }, USER_POOL);
  throwOnErrors(res);
  return toGroupsPayload(res.data).groups;
}
