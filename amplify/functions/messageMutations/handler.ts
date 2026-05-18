import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for Message custom mutations.
 *
 * Dispatches on `event.info.fieldName`:
 *   - `softDeleteMessage` (#28) — admin-only. Sets `deletedAt` /
 *     `deletedBy` / `deletedReason` on the target Message. Idempotent
 *     — a second call on an already-deleted row returns the row
 *     untouched.
 *   - `submitRecordingLessMessage` (#285) — authenticated witness
 *     submission with no associated Recording. Enforces a per-user
 *     daily rate-limit (queried via the `submitterId` GSI), rejects
 *     banned users, and uses the caller's Reputation.computedWeight
 *     against a configurable threshold to decide publish-now vs.
 *     queued-for-review. Every submission lands with
 *     `flaggedForReview = true` regardless of the gate outcome and
 *     emits a `MESSAGE_SUBMIT_RECORDINGLESS` AuditLog entry with the
 *     verification provenance (rep, role, count, queued vs published).
 *
 * Returns the post-mutation Message row.
 */

export type MessageRow = {
  id: string;
  body?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletedReason?: string | null;
  broadcastTs?: string | null;
  sender?: string | null;
  receiver?: string | null;
  type?: string | null;
  flaggedForReview?: boolean | null;
  publishedAt?: string | null;
  submitterId?: string | null;
  submittedAt?: string | null;
  [k: string]: unknown;
};

export type UserRow = {
  cognitoSub: string;
  role?: string | null;
  bannedAt?: string | null;
  bannedReason?: string | null;
  [k: string]: unknown;
};

export type ReputationRow = {
  userId: string;
  computedWeight?: number | null;
  [k: string]: unknown;
};

export interface MessageMutationsDataClient {
  models: {
    Message: {
      get: (input: { id: string }) => Promise<{ data: MessageRow | null; errors?: unknown }>;
      update: (
        input: Partial<MessageRow> & { id: string },
      ) => Promise<{ data: MessageRow | null; errors?: unknown }>;
      create: (
        input: Partial<MessageRow>,
      ) => Promise<{ data: MessageRow | null; errors?: unknown }>;
      /**
       * Auto-generated GSI lookup for `i('submitterId').sortKeys(['submittedAt'])`.
       * `submitRecordingLessMessage` calls this with a `submittedAt` predicate
       * to count the caller's submissions in the trailing rate-limit window.
       */
      listMessageBySubmitterId: (input: {
        submitterId: string;
        submittedAt?: { ge?: string; gt?: string };
      }) => Promise<{ data: MessageRow[] | null; errors?: unknown }>;
    };
    User: {
      get: (input: { cognitoSub: string }) => Promise<{ data: UserRow | null; errors?: unknown }>;
    };
    Reputation: {
      get: (input: { userId: string }) => Promise<{ data: ReputationRow | null; errors?: unknown }>;
    };
  };
}

const MESSAGE_TYPES = new Set<string>([
  'BACKEND',
  'SKYKING',
  'ALLSTATIONS',
  'RADIOCHECK',
  'SKYMASTER',
  'SKYBIRD',
  'DISREGARDED',
  'OTHER',
]);

function isModerator(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf('moderator') >= 0;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

interface Deps {
  dataClient?: MessageMutationsDataClient;
  audit?: AuditFn;
  now?: () => Date;
}

let injected: Deps = {};

export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedDefaultClient: MessageMutationsDataClient | undefined;

async function getDefaultClient(): Promise<MessageMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as MessageMutationsDataClient;
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

function snapshot(row: MessageRow): Record<string, unknown> {
  return { ...row };
}

async function dispatchSoftDelete(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, MessageRow | null>>[0],
  deps: { client: MessageMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<MessageRow | null> {
  if (!isAdmin(event.identity)) {
    throw new Error('softDeleteMessage: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('softDeleteMessage: caller has no identity sub');
  }

  const args = event.arguments;
  const targetId = typeof args.messageId === 'string' ? args.messageId : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!targetId) {
    throw new Error('softDeleteMessage: messageId argument is required');
  }

  const fetched = await deps.client.models.Message.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`softDeleteMessage: Message row not found for id=${targetId}`);
  }
  // Idempotent — once a row is marked deletedAt, re-runs return the
  // existing row untouched. No second audit entry, no overwrite of
  // the original deletedBy / deletedReason.
  if (before.deletedAt) {
    return before;
  }

  const now = deps.now().toISOString();
  // Normalise empty reason to null on both row + audit so a future
  // "deletes with no reason" query targets the same predicate
  // (#269 review pattern).
  const normalisedReason: string | null = reason ? reason : null;

  const patch: Partial<MessageRow> & { id: string } = {
    id: targetId,
    deletedAt: now,
    deletedBy: actorSub,
    deletedReason: normalisedReason,
  };
  const updated = await deps.client.models.Message.update(patch);
  if (updated.errors) {
    throw new Error(
      `softDeleteMessage: Message.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  await deps.audit(auditContextFrom(event), {
    action: 'MESSAGE_DELETE',
    targetType: 'Message',
    targetId,
    before: snapshot(before),
    after: snapshot(after),
    reason: normalisedReason,
  });

  return after;
}

interface SubmitRecordingLessArgs {
  broadcastTs?: unknown;
  sender?: unknown;
  receiver?: unknown;
  type?: unknown;
  body?: unknown;
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function dispatchSubmitRecordingLess(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, MessageRow | null>>[0],
  deps: { client: MessageMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<MessageRow> {
  const sub = identitySub(event.identity);
  if (!sub) {
    throw new Error('submitRecordingLessMessage: caller has no identity (not signed in)');
  }
  const callerIsAdmin = isAdmin(event.identity);
  const callerIsModerator = isModerator(event.identity);

  const args = event.arguments as SubmitRecordingLessArgs;
  const broadcastTs = pickString(args.broadcastTs);
  if (!broadcastTs) {
    throw new Error('submitRecordingLessMessage: broadcastTs argument is required');
  }
  if (Number.isNaN(Date.parse(broadcastTs))) {
    throw new Error('submitRecordingLessMessage: broadcastTs must be ISO-8601');
  }
  const typeArg = pickString(args.type);
  if (typeArg !== null && !MESSAGE_TYPES.has(typeArg)) {
    throw new Error(`submitRecordingLessMessage: unknown message type "${typeArg}"`);
  }

  // Ban check. A banned user must not be able to inject witness
  // submissions even if their Cognito token is still valid (revocation
  // can lag). The User row's `bannedAt` sentinel is authoritative.
  const userFetched = await deps.client.models.User.get({ cognitoSub: sub });
  const user = userFetched.data;
  if (user?.bannedAt) {
    throw new Error('submitRecordingLessMessage: caller is banned');
  }

  // Rate-limit window — count submissions in the trailing N hours via
  // the `submitterId` GSI. Admins skip the check entirely; moderators
  // get a higher cap than members.
  const windowHours = envNumber('RECORDINGLESS_RATE_LIMIT_WINDOW_HOURS', 24);
  const memberCap = envNumber('RECORDINGLESS_RATE_LIMIT_MEMBER', 5);
  const modCap = envNumber('RECORDINGLESS_RATE_LIMIT_MOD', 20);
  const cap = callerIsAdmin ? Number.POSITIVE_INFINITY : callerIsModerator ? modCap : memberCap;

  const nowDate = deps.now();
  const windowStart = new Date(nowDate.getTime() - windowHours * 3600_000).toISOString();
  let recentCount = 0;
  if (Number.isFinite(cap)) {
    const recent = await deps.client.models.Message.listMessageBySubmitterId({
      submitterId: sub,
      submittedAt: { ge: windowStart },
    });
    if (recent.errors) {
      throw new Error(
        `submitRecordingLessMessage: rate-limit query returned errors: ${JSON.stringify(
          recent.errors,
        )}`,
      );
    }
    // Belt-and-suspenders boundary filter. The GSI predicate
    // `submittedAt: { ge: windowStart }` already restricts the Query
    // to in-window rows on the DDB side, but recount in-handler so
    // (a) a stub / future Amplify change that ignores the predicate
    // can't silently inflate the count, and (b) any row whose
    // `submittedAt` is null / missing is excluded explicitly.
    recentCount = (recent.data ?? []).filter(
      (m) => typeof m.submittedAt === 'string' && m.submittedAt >= windowStart,
    ).length;
    if (recentCount >= cap) {
      throw new Error(
        `submitRecordingLessMessage: rate limit exceeded (${recentCount}/${cap} in last ${windowHours}h)`,
      );
    }
  }

  // Reputation gate decides publish-now vs. queue. Moderators + admins
  // always publish-now (they're trusted to file accurate witness
  // accounts). Member-level callers below threshold land queued — the
  // Message still exists and is visible to mods, but `publishedAt`
  // stays null so it doesn't appear in public lists until a mod
  // approves it (mod-approval flow tracked separately).
  //
  // Default weight when no Reputation row exists is 1 — same as the
  // baseline `.default(1)` on the model. That means a fresh signup
  // with no validated history defaults to *queued* under the default
  // 1.5 threshold. That is the intended safety-first stance: a brand-
  // new account has no track record, so the first few submissions go
  // through moderator review until accepted corrections / submissions
  // lift the weight above the threshold.
  const repThreshold = envNumber('RECORDINGLESS_REP_THRESHOLD', 1.5);
  const repFetched = await deps.client.models.Reputation.get({ userId: sub });
  const repWeight = repFetched.data?.computedWeight ?? 1;
  const roleBypass = callerIsAdmin || callerIsModerator;
  const queued = !roleBypass && repWeight < repThreshold;

  const nowIso = nowDate.toISOString();
  const created = await deps.client.models.Message.create({
    broadcastTs,
    sender: pickString(args.sender),
    receiver: pickString(args.receiver),
    type: typeArg,
    body: pickString(args.body),
    flaggedForReview: true,
    publishedAt: queued ? null : nowIso,
    submitterId: sub,
    submittedAt: nowIso,
    migratedFromV3: false,
  });
  if (created.errors) {
    throw new Error(
      `submitRecordingLessMessage: Message.create returned errors: ${JSON.stringify(
        created.errors,
      )}`,
    );
  }
  const after = created.data;
  if (!after) {
    throw new Error('submitRecordingLessMessage: Message.create returned no data');
  }

  // Verification provenance — captures everything a moderator (or
  // future incident reviewer) needs to understand why this submission
  // landed where it did. Stored in the audit row's `after` payload so
  // the audit-helper diff also picks it up.
  //
  // Audit failure must NOT roll back the user's just-created Message
  // — the Message is the user-facing artefact and the right of way.
  // Log + continue keeps the submission usable while the audit gap
  // can be back-filled by ops (or picked up by a janitor sweep
  // following the #274 pattern, if it ever becomes a real problem).
  try {
    await deps.audit(auditContextFrom(event), {
      action: 'MESSAGE_SUBMIT_RECORDINGLESS',
      targetType: 'Message',
      targetId: after.id,
      after: {
        ...snapshot(after),
        verification: {
          role: callerIsAdmin ? 'admin' : callerIsModerator ? 'moderator' : 'member',
          reputationWeight: repWeight,
          reputationThreshold: repThreshold,
          rateLimitCount: recentCount,
          rateLimitCap: Number.isFinite(cap) ? cap : null,
          rateLimitWindowHours: windowHours,
          outcome: queued ? 'QUEUED' : 'PUBLISHED',
        },
      },
    });
  } catch (err: unknown) {
    console.warn(
      `submitRecordingLessMessage: audit write failed for messageId=${after.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return after;
}

export const handler: AppSyncResolverHandler<Record<string, unknown>, MessageRow | null> = async (
  event,
) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());
  const deps = { client, audit: auditFn, now };

  const field = event.info.fieldName;
  switch (field) {
    case 'softDeleteMessage':
      return dispatchSoftDelete(event, deps);
    case 'submitRecordingLessMessage':
      return dispatchSubmitRecordingLess(event, deps);
    default:
      throw new Error(`messageMutations: unsupported fieldName "${field}"`);
  }
};
