/**
 * AuditLog helper — the ONE place that writes `AuditLog` rows.
 *
 * Always go through this helper; never hand-roll AuditLog.create() in
 * resolvers — see issue #258.
 *
 * Every admin / mod / system action that mutates user-visible state (deletes,
 * bans, role changes, config updates, etc.) routes through `audit(ctx, opts)`.
 * That single chokepoint guarantees a uniform shape across `actorId`, the
 * polymorphic `targetType` + `targetId`, the shallow `diff`, and request
 * metadata (`ipAddress`, `userAgent`). It also lets us evolve the audit shape
 * (new fields, new redactions, switched storage backend) in one file.
 *
 * Lifecycle:
 *
 *   1. Each Lambda-backed resolver builds its `before` + `after` snapshots of
 *      whatever it just mutated, then calls `await audit(ctx, { ... })`.
 *   2. The helper reads `ctx.identity.sub` for the actor; if absent, the row
 *      is recorded as a system-emitted entry (`actorId: null`) per the model
 *      contract on `amplify/data/models/audit-log.ts`.
 *   3. It captures `ipAddress` from the first hop of `x-forwarded-for` and
 *      `userAgent` from the `user-agent` request header.
 *   4. It computes a shallow `{ before, after }` diff keyed by field name.
 *   5. It posts the row through the Amplify Data client (AppSync IAM
 *      connection in production) and returns the new entry's id.
 *
 * Wiring this helper into each individual admin mutation is intentionally
 * out of scope for #258 — that lands per follow-up mutation (#28, #29, #32,
 * #248, etc.).
 */

import { type Schema } from './resource';

/**
 * Every `action` value defined on the `AuditLog` model. Source of truth lives
 * in `amplify/data/models/audit-log.ts`; if you add an enum value there, add
 * it here too — the helper's parametrized test will scream if they drift.
 *
 * The #258 issue body listed "19 enum values"; the model actually carries
 * 20 (the issue was written before the final phase-2 schema landed in #257).
 */
export const AUDIT_ACTIONS = [
  'MESSAGE_DELETE',
  'MESSAGE_RESTORE',
  'MESSAGE_EDIT',
  'RECORDING_DELETE',
  'RECORDING_RESTORE',
  'COMMENT_DELETE',
  'USER_BAN',
  'USER_UNBAN',
  'USER_ROLE_CHANGE',
  'USER_PII_BLANK',
  'USER_CLAIM',
  'USER_CLAIM_FANOUT',
  'FIELDVOTE_ORPHAN_SWEEP',
  'TRANSMITTER_CREATE',
  'TRANSMITTER_UPDATE',
  'TRANSMITTER_DELETE',
  'CALLSIGN_MERGE',
  'LINGUISTIC_CONFIG_UPDATE',
  'BAN_REGION_PAGE_UPDATE',
  'PROMPT_VERSION_BUMP',
  'BUDGET_THRESHOLD_UPDATE',
  'REP_FORMULA_UPDATE',
  'OTHER',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Resolver request context, narrowed to the parts the helper consumes. We do
 * not import the AppSync runtime type here so this helper stays usable from
 * Lambda handlers, AppSync JS pipelines, and unit tests alike.
 */
export interface AuditContext {
  identity?: {
    sub?: string | null;
  } | null;
  request?: {
    headers?: Record<string, string | undefined>;
  };
}

export interface AuditOptions {
  action: AuditAction;
  /** Polymorphic target type — e.g. `Message`, `User`, `Recording`. */
  targetType: string;
  /** Primary key of the target row. */
  targetId: string;
  /** Snapshot of the target before the mutation, for diff computation. */
  before?: Record<string, unknown>;
  /** Snapshot of the target after the mutation, for diff computation. */
  after?: Record<string, unknown>;
  /**
   * Human-readable reason; required for moderator-discretion actions.
   * Callers may pass `null` for "no reason"; the DB column stores
   * `null` in both the omitted and the explicit-null case so a single
   * `reason = NULL` predicate finds both shapes.
   */
  reason?: string | null;
  /**
   * Cross-entry correlation key. Persisted as the `claimId` column on
   * AuditLog. The legacy-claim sub-flows (#272 / #273 / #274) thread
   * the same `claimId` through every audit entry that belongs to a
   * single claim — the replay sweeper (#274) groups by this column to
   * know what work has already been done. Other audit actions can
   * leave it undefined.
   */
  claimId?: string | null;
}

/**
 * Shape of the Amplify Data client we need — only the AuditLog.create entry
 * point. Declared structurally so tests can pass a stub without dragging the
 * full `generateClient<Schema>()` surface into the unit test.
 *
 * In production this is satisfied by `generateClient<Schema>({ authMode:
 * 'iam' })` from `aws-amplify/data`.
 */
export interface AuditDataClient {
  models: {
    AuditLog: {
      create: (
        input: AuditLogCreateInput,
      ) => Promise<{ data: { id: string } | null; errors?: unknown }>;
    };
  };
}

/**
 * Shape of the row written to DynamoDB. Mirrors the fields declared on
 * `amplify/data/models/audit-log.ts` exactly.
 */
export interface AuditLogCreateInput {
  actorId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string;
  targetMessageId: string | null;
  diff: Record<string, { before: unknown; after: unknown }> | null;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  claimId: string | null;
}

export interface AuditDeps {
  /** Override the data client (used by tests + custom transport experiments). */
  client?: AuditDataClient;
}

/**
 * Lazily-built default client. We do not call `generateClient` at module load
 * because (a) it requires `Amplify.configure(amplifyOutputs)` to have run
 * first and (b) some test environments never configure Amplify at all. The
 * production code path triggers the import on first call.
 */
let cachedDefaultClient: AuditDataClient | undefined;

async function getDefaultClient(): Promise<AuditDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  // Dynamic import so test runs that inject a `client` never need to load the
  // Amplify runtime. `generateClient<Schema>()` returns the strongly-typed
  // model client; our structural `AuditDataClient` is a subset of that
  // surface, so the assignment is safe without a cast.
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient<Schema>({ authMode: 'iam' });
  return cachedDefaultClient;
}

/**
 * Shallow object diff: returns one `{ before, after }` entry per key whose
 * value differs between the two snapshots. Keys present in only one side are
 * still emitted (the absent side is `undefined`). Equality is strict (`===`);
 * nested objects are compared by reference, which is intentional — audit
 * payloads are flat snapshots of DDB rows.
 */
export function diffShallow(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (b !== a) {
      out[k] = { before: b, after: a };
    }
  }
  return out;
}

function firstForwardedHop(value: string | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * Emit an AuditLog row for an action that just happened.
 *
 * Throws if both `targetType` and `targetId` are missing — an audit entry
 * with no target is meaningless. Returns the id of the newly-created row.
 */
export async function audit(
  ctx: AuditContext,
  opts: AuditOptions,
  deps: AuditDeps = {},
): Promise<string> {
  if (!opts.targetType || !opts.targetId) {
    throw new Error(
      'audit(): both targetType and targetId are required (audit entry without a target is meaningless)',
    );
  }

  const headers = ctx.request?.headers ?? {};
  const ipAddress = firstForwardedHop(headers['x-forwarded-for']);
  const userAgent = headers['user-agent'] ?? null;
  const actorId = ctx.identity?.sub ?? null;

  const hasBefore = opts.before !== undefined;
  const hasAfter = opts.after !== undefined;
  const diff = hasBefore || hasAfter ? diffShallow(opts.before ?? {}, opts.after ?? {}) : null;

  const input: AuditLogCreateInput = {
    actorId,
    action: opts.action,
    targetType: opts.targetType,
    targetId: opts.targetId,
    targetMessageId: opts.targetType === 'Message' ? opts.targetId : null,
    diff,
    reason: opts.reason ?? null,
    ipAddress,
    userAgent,
    claimId: opts.claimId ?? null,
  };

  const client = deps.client ?? (await getDefaultClient());
  const result = await client.models.AuditLog.create(input);

  if (result.errors && (result.errors as unknown[]).length > 0) {
    throw new Error(`audit(): AuditLog.create returned errors: ${JSON.stringify(result.errors)}`);
  }
  if (!result.data?.id) {
    throw new Error('audit(): AuditLog.create returned no id');
  }
  return result.data.id;
}
