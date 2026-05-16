import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for `selfDelete` + `banUser` mutations
 * (issue #248).
 *
 * Dispatches on `event.info.fieldName`:
 *   - `selfDelete` — caller blanks own PII on the User row keyed by their
 *     Cognito sub. Writes a `USER_PII_BLANK` audit row. Idempotent — a
 *     second call on an already-blanked row is a no-op.
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
  role?: string | null;
  piiBlanked?: boolean | null;
  piiBlankedAt?: string | null;
  bannedAt?: string | null;
  bannedReason?: string | null;
  bannedById?: string | null;
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
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

interface Deps {
  dataClient?: UserMutationsDataClient;
  audit?: AuditFn;
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
  const mod = await import('aws-amplify/data');
  // We need a Schema generic from data/resource, but importing the
  // schema (which imports CDK) into a runtime Lambda would fail. The
  // client is structurally satisfied by the untyped runtime surface.
  const client = mod.generateClient({ authMode: 'iam' }) as unknown as UserMutationsDataClient;
  cachedDefaultClient = client;
  return cachedDefaultClient;
}

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

  return after;
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

/**
 * Cheap row snapshot for the audit `before` / `after` diff. The helper's
 * `diffShallow` only inspects own enumerable keys; copying via the
 * spread operator is enough and keeps the diff payload narrow.
 */
function snapshot(row: UserRow): Record<string, unknown> {
  return { ...row };
}

export const handler: AppSyncResolverHandler<Record<string, unknown>, UserRow | null> = async (
  event,
) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());
  const deps = { client, audit: auditFn, now };

  const field = event.info.fieldName;
  switch (field) {
    case 'selfDelete':
      return dispatchSelfDelete(event, deps);
    case 'banUser':
      return dispatchBanUser(event, deps);
    default:
      throw new Error(`userMutations: unsupported fieldName "${field}"`);
  }
};
