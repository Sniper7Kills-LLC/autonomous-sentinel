import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for `selfDelete` + `banUser` mutations
 * (issue #248) and `updateProfile` (issue #736).
 *
 * Dispatches on `event.info.fieldName`:
 *   - `selfDelete` — caller blanks own PII on the User row keyed by their
 *     Cognito sub. Writes a `USER_PII_BLANK` audit row. Idempotent — a
 *     second call on an already-blanked row is a no-op.
 *   - `updateProfile` — caller edits ONLY displayName / preferredUsername /
 *     bio / avatarKey on the User row keyed by their Cognito sub. Rejects
 *     banned callers + length-overflows. Writes a `USER_PROFILE_UPDATE`
 *     audit row. Never touches role / ban / pii / claim columns.
 *   - `banUser` — admin-only. Sets `bannedAt` / `bannedReason` /
 *     `bannedById` on the target row. Writes a `USER_BAN` audit row.
 *
 * Why Lambda (vs an AppSync JS pipeline): the cross-cutting `audit()`
 * helper from #258 lives in TypeScript and writes to a separate data
 * source (AuditLog). CLAUDE.md's hard rule is "never hand-roll
 * AuditLog.create() in your resolvers" — so any mutation that audits has
 * to call through the helper. JS pipelines can't import shared TS
 * modules; Lambda can.
 *
 * Both mutations return the post-mutation User row to the caller.
 */

type UserRow = {
  cognitoSub: string;
  email?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarKey?: string | null;
  role?: string | null;
  piiBlanked?: boolean | null;
  piiBlankedAt?: string | null;
  bannedAt?: string | null;
  bannedReason?: string | null;
  bannedById?: string | null;
  [k: string]: unknown;
};

/**
 * Subset of Sdr columns the selfDelete cascade reads + writes. The
 * cascade leaves transmitter / recordings / publicVisible alone — only
 * PII (name, notes, lat/lon when EXACT) is touched.
 */
type SdrRow = {
  id: string;
  name?: string | null;
  notes?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationGranularity?: 'EXACT' | 'CITY' | 'REGION' | null;
  ownerId?: string | null;
  [k: string]: unknown;
};

/**
 * Structural shape of the Amplify Data client we need. Declared narrowly
 * so tests inject a stub without dragging the full `generateClient`
 * surface into the unit test.
 */
export interface UserMutationsDataClient {
  models: {
    User: {
      get: (input: { cognitoSub: string }) => Promise<{ data: UserRow | null; errors?: unknown }>;
      update: (
        input: Partial<UserRow> & { cognitoSub: string },
      ) => Promise<{ data: UserRow | null; errors?: unknown }>;
    };
    Sdr: {
      /**
       * Auto-generated GSI lookup for `i('ownerId')` on Sdr (#257).
       * Selfdelete cascade Queries this to find every Sdr owned by
       * the user whose row is being blanked.
       */
      listSdrByOwnerId: (input: { ownerId: string }) => Promise<{
        data: SdrRow[] | null;
        errors?: unknown;
      }>;
      update: (
        input: Partial<SdrRow> & { id: string },
      ) => Promise<{ data: SdrRow | null; errors?: unknown }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

/**
 * Narrow Cognito admin surface the `setUserGroup` / `listUserGroups`
 * operations need (#743). Declared structurally so tests inject a stub
 * without dragging the full `@aws-sdk/client-cognito-identity-provider`
 * client in. The production client wraps the Admin* commands against the
 * `USER_POOL_ID` user pool.
 */
export interface CognitoAdminClient {
  addUserToGroup: (input: { cognitoSub: string; group: string }) => Promise<void>;
  removeUserFromGroup: (input: { cognitoSub: string; group: string }) => Promise<void>;
  listGroupsForUser: (input: { cognitoSub: string }) => Promise<string[]>;
}

interface Deps {
  dataClient?: UserMutationsDataClient;
  audit?: AuditFn;
  cognito?: CognitoAdminClient;
  /** Override the wall clock — only used in tests. */
  now?: () => Date;
}

let injected: Deps = {};

/** Test-only escape hatch — DI for the data client + audit helper. */
export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedDefaultClient: UserMutationsDataClient | undefined;

async function getDefaultClient(): Promise<UserMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  // Dynamic import so unit tests that inject a client never load the
  // Amplify runtime. The production Lambda execution role assumes IAM
  // and reaches the AppSync data plane via `generateClient`.
  // Lambda runtime has no auto-config — call Amplify.configure() before
  // generateClient or it throws. Shared helper in
  // amplify/functions/_shared/configure-amplify.ts.
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  // We need a Schema generic from data/resource, but importing the
  // schema (which imports CDK) into a runtime Lambda would fail. The
  // client is structurally satisfied by the untyped runtime surface.
  const client = mod.generateClient({ authMode: 'iam' }) as unknown as UserMutationsDataClient;
  cachedDefaultClient = client;
  return cachedDefaultClient;
}

let cachedCognitoClient: CognitoAdminClient | undefined;

/**
 * Production Cognito admin client (#743). Wraps the Admin* group commands
 * against the user pool named by `USER_POOL_ID` (wired in `backend.ts`).
 * Dynamic import keeps the SDK out of unit tests that inject a stub.
 */
async function getDefaultCognito(): Promise<CognitoAdminClient> {
  if (cachedCognitoClient) return cachedCognitoClient;
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) {
    throw new Error('setUserGroup: USER_POOL_ID env var is not set');
  }
  const {
    CognitoIdentityProviderClient,
    AdminAddUserToGroupCommand,
    AdminRemoveUserFromGroupCommand,
    AdminListGroupsForUserCommand,
  } = await import('@aws-sdk/client-cognito-identity-provider');
  const client = new CognitoIdentityProviderClient({});
  cachedCognitoClient = {
    addUserToGroup: async ({ cognitoSub, group }) => {
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: cognitoSub,
          GroupName: group,
        }),
      );
    },
    removeUserFromGroup: async ({ cognitoSub, group }) => {
      await client.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: userPoolId,
          Username: cognitoSub,
          GroupName: group,
        }),
      );
    },
    listGroupsForUser: async ({ cognitoSub }) => {
      const out = await client.send(
        new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: cognitoSub }),
      );
      return (out.Groups ?? [])
        .map((g) => g.GroupName)
        .filter((n): n is string => typeof n === 'string');
    },
  };
  return cachedCognitoClient;
}

/**
 * Groups an admin may add/remove via `setUserGroup` (#743). Mirrors the
 * Cognito user-pool groups declared in `amplify/auth/resource.ts`.
 */
const ASSIGNABLE_GROUPS = ['admin', 'moderator', 'member', 'diagnostics'] as const;

/**
 * Hierarchy roles mirrored onto `User.role` for quick filtering/display
 * (highest-first). `diagnostics` is an additive capability group, NOT a
 * hierarchy role, so it never appears here and never rewrites the mirror.
 */
const ROLE_HIERARCHY = ['admin', 'moderator', 'member'] as const;

function isAdmin(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf('admin') >= 0;
}

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function auditContextFrom(event: {
  identity?: unknown;
  request?: { headers?: Record<string, string | undefined> };
}): AuditContext {
  const sub = identitySub(event.identity);
  return {
    identity: sub ? { sub } : null,
    request: { headers: event.request?.headers ?? {} },
  };
}

async function dispatchSelfDelete(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, UserRow | null>>[0],
  deps: { client: UserMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<UserRow | null> {
  const sub = identitySub(event.identity);
  if (!sub) {
    throw new Error('selfDelete: caller has no identity (not signed in)');
  }

  const fetched = await deps.client.models.User.get({ cognitoSub: sub });
  const before = fetched.data;
  if (!before) {
    throw new Error(`selfDelete: User row not found for cognitoSub=${sub}`);
  }
  // Idempotent — if already blanked, return the existing row untouched.
  // The Sdr cascade is also skipped in this branch: re-running it would
  // re-emit `SDR_PII_BLANK` audits for already-wiped rows and pollute
  // the audit log. Recovery from a partial first-pass cascade is the
  // job of a janitor sweep follow-up (mirror of #274), not a user-
  // triggered second selfDelete call.
  if (before.piiBlanked === true) {
    return before;
  }

  const now = deps.now().toISOString();
  const patch: Partial<UserRow> & { cognitoSub: string } = {
    cognitoSub: sub,
    email: null,
    preferredUsername: null,
    displayName: null,
    piiBlanked: true,
    piiBlankedAt: now,
  };
  const updated = await deps.client.models.User.update(patch);
  if (updated.errors) {
    throw new Error(`selfDelete: User.update returned errors: ${JSON.stringify(updated.errors)}`);
  }
  const after = updated.data ?? { ...before, ...patch };

  await deps.audit(auditContextFrom(event), {
    action: 'USER_PII_BLANK',
    targetType: 'User',
    targetId: sub,
    before: snapshot(before),
    after: snapshot(after),
  });

  // PII cascade to owned Sdrs (#286). Each Sdr row owned by this
  // user has `name` replaced with `[deleted]` (name is required at
  // the model level, so we can't null it), `notes` nulled, and (only
  // when `locationGranularity === 'EXACT'`) lat/lon nulled. Non-
  // EXACT granularities are already blurred by `listSdrPublic`, so
  // the public-facing precision degrades gracefully without touching
  // the row.
  //
  // We do NOT soft-delete the Sdr — recordings that link back to
  // this Sdr (via `Recording.sdrId`) keep resolving the row so admin
  // attribution tooling still works.
  //
  // One audit entry per Sdr (targetType=Sdr, action=USER_PII_BLANK)
  // so the user-facing audit log shows what was wiped. Errors on a
  // single Sdr do NOT roll back the User blank — the User row is
  // the source of truth for "this account is gone", and a partial
  // Sdr cascade is recoverable by the daily replay sweeper pattern
  // (mirror of #274 if it ever becomes a real issue).
  await cascadeSdrPii(event, deps, sub);

  return after;
}

async function cascadeSdrPii(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, UserRow | null>>[0],
  deps: { client: UserMutationsDataClient; audit: AuditFn; now: () => Date },
  ownerSub: string,
): Promise<void> {
  const sdrs = await deps.client.models.Sdr.listSdrByOwnerId({ ownerId: ownerSub });
  const rows = sdrs.data ?? [];
  for (const before of rows) {
    const patch: Partial<SdrRow> & { id: string } = {
      id: before.id,
      name: '[deleted]',
      notes: null,
    };
    if (before.locationGranularity === 'EXACT') {
      patch.latitude = null;
      patch.longitude = null;
    }
    const updated = await deps.client.models.Sdr.update(patch);
    if (updated.errors) {
      // Do not throw — the User row is the source of truth for the
      // account being gone. Leave a console trace so a janitor sweep
      // can pick this up later if needed.
      console.warn(
        `selfDelete: Sdr.update returned errors for id=${before.id}: ${JSON.stringify(updated.errors)}`,
      );
      continue;
    }
    const after = updated.data ?? { ...before, ...patch };
    await deps.audit(auditContextFrom(event), {
      action: 'SDR_PII_BLANK',
      targetType: 'Sdr',
      targetId: before.id,
      before: snapshotSdr(before),
      after: snapshotSdr(after),
    });
  }
}

function snapshotSdr(row: SdrRow): Record<string, unknown> {
  return { ...row };
}

async function dispatchBanUser(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, UserRow | null>>[0],
  deps: { client: UserMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<UserRow | null> {
  if (!isAdmin(event.identity)) {
    throw new Error('banUser: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    // isAdmin already false would have caught this in practice, but the
    // explicit guard pins the contract: an admin without a sub claim
    // means a misconfigured request — fail closed.
    throw new Error('banUser: caller has no identity sub');
  }

  const args = event.arguments;
  const target = typeof args.targetCognitoSub === 'string' ? args.targetCognitoSub : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!target) {
    throw new Error('banUser: targetCognitoSub argument is required');
  }

  const fetched = await deps.client.models.User.get({ cognitoSub: target });
  const before = fetched.data;
  if (!before) {
    throw new Error(`banUser: User row not found for cognitoSub=${target}`);
  }

  const now = deps.now().toISOString();
  const patch: Partial<UserRow> & { cognitoSub: string } = {
    cognitoSub: target,
    bannedAt: now,
    bannedReason: reason || null,
    bannedById: actorSub,
  };
  const updated = await deps.client.models.User.update(patch);
  if (updated.errors) {
    throw new Error(`banUser: User.update returned errors: ${JSON.stringify(updated.errors)}`);
  }
  const after = updated.data ?? { ...before, ...patch };

  // Normalise the empty / missing reason once so both the row column
  // and the audit entry record it the same way (review on PR #269).
  // Using `null` lets a future "find bans with no reason" query target
  // the same predicate against the User row and its AuditLog row.
  const normalisedReason: string | null = reason ? reason : null;

  await deps.audit(auditContextFrom(event), {
    action: 'USER_BAN',
    targetType: 'User',
    targetId: target,
    before: snapshot(before),
    after: snapshot(after),
    reason: normalisedReason,
  });

  return after;
}

async function dispatchUnbanUser(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, UserRow | null>>[0],
  deps: { client: UserMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<UserRow | null> {
  if (!isAdmin(event.identity)) {
    throw new Error('unbanUser: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('unbanUser: caller has no identity sub');
  }

  const args = event.arguments;
  const target = typeof args.targetCognitoSub === 'string' ? args.targetCognitoSub : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!target) {
    throw new Error('unbanUser: targetCognitoSub argument is required');
  }

  const fetched = await deps.client.models.User.get({ cognitoSub: target });
  const before = fetched.data;
  if (!before) {
    throw new Error(`unbanUser: User row not found for cognitoSub=${target}`);
  }
  // Idempotent — un-banning a row that is not banned returns it untouched
  // and writes no audit entry (mirrors the softDeleteMessage no-op path).
  if (!before.bannedAt) {
    return before;
  }

  const patch: Partial<UserRow> & { cognitoSub: string } = {
    cognitoSub: target,
    bannedAt: null,
    bannedReason: null,
    bannedById: null,
  };
  const updated = await deps.client.models.User.update(patch);
  if (updated.errors) {
    throw new Error(`unbanUser: User.update returned errors: ${JSON.stringify(updated.errors)}`);
  }
  const after = updated.data ?? { ...before, ...patch };

  const normalisedReason: string | null = reason ? reason : null;
  await deps.audit(auditContextFrom(event), {
    action: 'USER_UNBAN',
    targetType: 'User',
    targetId: target,
    before: snapshot(before),
    after: snapshot(after),
    reason: normalisedReason,
  });

  return after;
}

/**
 * Editable profile fields and their max trimmed length (#736). The
 * handler walks this map so adding a field is a one-line change and the
 * length guard stays in lock-step with the column set. Sensitive columns
 * (role / ban / pii / claim) are deliberately absent — they can never be
 * reached through this path.
 */
const PROFILE_FIELDS = {
  displayName: 80,
  preferredUsername: 80,
  bio: 500,
} as const;

async function dispatchUpdateProfile(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, UserRow | null>>[0],
  deps: { client: UserMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<UserRow | null> {
  const sub = identitySub(event.identity);
  if (!sub) {
    throw new Error('updateProfile: caller has no identity (not signed in)');
  }

  const fetched = await deps.client.models.User.get({ cognitoSub: sub });
  const before = fetched.data;
  if (!before) {
    throw new Error(`updateProfile: User row not found for cognitoSub=${sub}`);
  }
  // Banned callers cannot edit their profile.
  if (before.bannedAt) {
    throw new Error('updateProfile: banned users cannot edit their profile');
  }

  const args = event.arguments;

  // Build a patch from ONLY the provided, length-checked profile fields.
  // An explicit empty string clears the field (stored as null); an
  // omitted / undefined arg is ignored so partial updates are possible.
  const patch: Partial<UserRow> & { cognitoSub: string } = { cognitoSub: sub };
  let touched = false;
  for (const [field, maxLen] of Object.entries(PROFILE_FIELDS)) {
    const raw = args[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new Error(`updateProfile: ${field} must be a string`);
    }
    const trimmed = raw.trim();
    if (trimmed.length > maxLen) {
      throw new Error(`updateProfile: ${field} exceeds ${maxLen} characters`);
    }
    // Empty string clears the field (store null); otherwise store trimmed.
    (patch as Record<string, unknown>)[field] = trimmed.length === 0 ? null : trimmed;
    touched = true;
  }
  // avatarKey is an opaque S3 key — trimmed + length-guarded like a path,
  // but with the same clear-on-empty semantics. Kept out of PROFILE_FIELDS
  // because it is not user-visible prose (no prose length cap applies; we
  // still bound it so a hostile caller can't store an unbounded key).
  const avatarRaw = args.avatarKey;
  if (avatarRaw !== undefined && avatarRaw !== null) {
    if (typeof avatarRaw !== 'string') {
      throw new Error('updateProfile: avatarKey must be a string');
    }
    const trimmed = avatarRaw.trim();
    if (trimmed.length > 1024) {
      throw new Error('updateProfile: avatarKey exceeds 1024 characters');
    }
    patch.avatarKey = trimmed.length === 0 ? null : trimmed;
    touched = true;
  }

  // Nothing to change — return the row untouched, write no audit.
  if (!touched) {
    return before;
  }

  const updated = await deps.client.models.User.update(patch);
  if (updated.errors) {
    throw new Error(
      `updateProfile: User.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  await deps.audit(auditContextFrom(event), {
    action: 'USER_PROFILE_UPDATE',
    targetType: 'User',
    targetId: sub,
    before: snapshot(before),
    after: snapshot(after),
    reason: 'self profile edit',
  });

  return after;
}

/**
 * Cheap row snapshot for the audit `before` / `after` diff. The helper's
 * `diffShallow` only inspects own enumerable keys; copying via the
 * spread operator is enough and keeps the diff payload narrow.
 */
function snapshot(row: UserRow): Record<string, unknown> {
  return { ...row };
}

type GroupsResult = { cognitoSub: string; groups: string[] };

/** Highest hierarchy role present in a group list, or null when none. */
function deriveRole(groups: readonly string[]): string | null {
  for (const role of ROLE_HIERARCHY) {
    if (groups.includes(role)) return role;
  }
  return null;
}

/**
 * `setUserGroup` — admin adds/removes a target user to/from a Cognito
 * group (#743). The `cognito:groups` claim is the source of truth for
 * authorization; this also keeps the `User.role` mirror coherent when a
 * hierarchy group (admin/moderator/member) changes. `diagnostics` is
 * additive and never rewrites the role mirror. Emits a `USER_ROLE_CHANGE`
 * audit entry with before/after group lists. Returns the post-change
 * group list.
 */
async function dispatchSetUserGroup(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, unknown>>[0],
  deps: { client: UserMutationsDataClient; audit: AuditFn; cognito: CognitoAdminClient },
): Promise<GroupsResult> {
  if (!isAdmin(event.identity)) {
    throw new Error('setUserGroup: caller is not in the admin group');
  }
  const args = event.arguments;
  const target = typeof args.targetCognitoSub === 'string' ? args.targetCognitoSub : '';
  const group = typeof args.group === 'string' ? args.group : '';
  const action = typeof args.action === 'string' ? args.action : '';
  if (!target) {
    throw new Error('setUserGroup: targetCognitoSub argument is required');
  }
  if (!ASSIGNABLE_GROUPS.includes(group as (typeof ASSIGNABLE_GROUPS)[number])) {
    throw new Error(
      `setUserGroup: unknown group "${group}" (allowed: ${ASSIGNABLE_GROUPS.join(', ')})`,
    );
  }
  if (action !== 'add' && action !== 'remove') {
    throw new Error(`setUserGroup: action must be "add" or "remove" (got "${action}")`);
  }

  const before = await deps.cognito.listGroupsForUser({ cognitoSub: target });
  if (action === 'add') {
    await deps.cognito.addUserToGroup({ cognitoSub: target, group });
  } else {
    await deps.cognito.removeUserFromGroup({ cognitoSub: target, group });
  }
  const after = await deps.cognito.listGroupsForUser({ cognitoSub: target });

  // Keep the role mirror coherent only when a hierarchy group changed.
  // diagnostics-only edits leave User.role untouched (no DDB write).
  const newRole = deriveRole(after);
  const oldRole = deriveRole(before);
  if (newRole && newRole !== oldRole) {
    const updated = await deps.client.models.User.update({ cognitoSub: target, role: newRole });
    if (updated.errors) {
      throw new Error(
        `setUserGroup: User.update returned errors: ${JSON.stringify(updated.errors)}`,
      );
    }
  }

  await deps.audit(auditContextFrom(event), {
    action: 'USER_ROLE_CHANGE',
    targetType: 'User',
    targetId: target,
    before: { groups: before },
    after: { groups: after },
    reason: `${action} group ${group}`,
  });

  return { cognitoSub: target, groups: after };
}

/**
 * `listUserGroups` — admin reads a target user's current Cognito groups
 * (#743). Read-only: no mutation, no audit. Powers the admin
 * group-management UI's initial display.
 */
async function dispatchListUserGroups(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, unknown>>[0],
  deps: { cognito: CognitoAdminClient },
): Promise<GroupsResult> {
  if (!isAdmin(event.identity)) {
    throw new Error('listUserGroups: caller is not in the admin group');
  }
  const args = event.arguments;
  const target = typeof args.targetCognitoSub === 'string' ? args.targetCognitoSub : '';
  if (!target) {
    throw new Error('listUserGroups: targetCognitoSub argument is required');
  }
  const groups = await deps.cognito.listGroupsForUser({ cognitoSub: target });
  return { cognitoSub: target, groups };
}

export const handler: AppSyncResolverHandler<
  Record<string, unknown>,
  UserRow | GroupsResult | null
> = async (event, _context, _callback) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());
  const deps = { client, audit: auditFn, now };

  // AppSync's pipeline-function payload puts `fieldName` at the top level
  // (see the VTL template generated by Amplify Gen 2 for Lambda data sources).
  // The `AppSyncResolverHandler` type "shapes" it under `info.fieldName` though,
  // and unit-test fixtures mirrored that shape. Accept both so real prod
  // invocations + existing tests keep working.
  const field = (event as unknown as { fieldName?: string }).fieldName ?? event.info?.fieldName;
  switch (field) {
    case 'selfDelete':
      return dispatchSelfDelete(event, deps);
    case 'updateProfile':
      return dispatchUpdateProfile(event, deps);
    case 'banUser':
      return dispatchBanUser(event, deps);
    case 'unbanUser':
      return dispatchUnbanUser(event, deps);
    case 'setUserGroup': {
      const cognito = injected.cognito ?? (await getDefaultCognito());
      return dispatchSetUserGroup(event, { client, audit: auditFn, cognito });
    }
    case 'listUserGroups': {
      const cognito = injected.cognito ?? (await getDefaultCognito());
      return dispatchListUserGroups(event, { cognito });
    }
    default:
      throw new Error(`userMutations: unsupported fieldName "${field}"`);
  }
};
