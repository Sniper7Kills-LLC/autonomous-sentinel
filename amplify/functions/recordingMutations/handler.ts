import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for the `softDeleteRecording`
 * custom mutation (#29). Mirrors the `softDeleteMessage` shape from
 * #28 / PR #280 so the cross-cutting AuditLog helper (#258) stays
 * the sole writer of the `RECORDING_DELETE` row.
 *
 * Dispatches on `event.info.fieldName`:
 *   - `softDeleteRecording` — admin-only. Sets `deletedAt` /
 *     `deletedBy` on the Recording row. Idempotent — a second call
 *     on an already-deleted row returns the row untouched.
 *
 * Recording carries no `deletedReason` column at the row level (per
 * the model definition in #257); the moderator's reason is captured
 * only on the AuditLog entry.
 *
 * Deferred (out of scope, tracked separately):
 *   - **Cascade-delete of the parent Message** when this Recording
 *     was the last one attached to it. CLAUDE.md is explicit:
 *     "messages with no recording cease to exist". Cascade is a
 *     multi-step transaction (Query Recording by messageId →
 *     count remaining → soft-delete Message if zero) that warrants
 *     its own follow-up.
 *   - **S3 hard-delete** of the original / web-canonical / sidecar
 *     keys. Phase 3 / storage lifecycle work.
 *
 * Returns the post-mutation Recording row.
 */

export type RecordingRow = {
  id: string;
  contentHash?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  [k: string]: unknown;
};

export interface RecordingMutationsDataClient {
  models: {
    Recording: {
      get: (input: { id: string }) => Promise<{
        data: RecordingRow | null;
        errors?: unknown;
      }>;
      update: (
        input: Partial<RecordingRow> & { id: string },
      ) => Promise<{ data: RecordingRow | null; errors?: unknown }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

interface Deps {
  dataClient?: RecordingMutationsDataClient;
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

let cachedDefaultClient: RecordingMutationsDataClient | undefined;

async function getDefaultClient(): Promise<RecordingMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as RecordingMutationsDataClient;
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

function snapshot(row: RecordingRow): Record<string, unknown> {
  return { ...row };
}

async function dispatchSoftDelete(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: { client: RecordingMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<RecordingRow | null> {
  if (!isAdmin(event.identity)) {
    throw new Error('softDeleteRecording: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('softDeleteRecording: caller has no identity sub');
  }

  const args = event.arguments;
  const targetId = typeof args.recordingId === 'string' ? args.recordingId : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!targetId) {
    throw new Error('softDeleteRecording: recordingId argument is required');
  }

  const fetched = await deps.client.models.Recording.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`softDeleteRecording: Recording row not found for id=${targetId}`);
  }
  if (before.deletedAt) {
    return before;
  }

  const now = deps.now().toISOString();
  const normalisedReason: string | null = reason ? reason : null;

  const patch: Partial<RecordingRow> & { id: string } = {
    id: targetId,
    deletedAt: now,
    deletedBy: actorSub,
  };
  const updated = await deps.client.models.Recording.update(patch);
  if (updated.errors) {
    throw new Error(
      `softDeleteRecording: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  await deps.audit(auditContextFrom(event), {
    action: 'RECORDING_DELETE',
    targetType: 'Recording',
    targetId,
    before: snapshot(before),
    after: snapshot(after),
    reason: normalisedReason,
  });

  return after;
}

export const handler: AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null> = async (
  event,
) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());
  const deps = { client, audit: auditFn, now };

  const field = event.info.fieldName;
  switch (field) {
    case 'softDeleteRecording':
      return dispatchSoftDelete(event, deps);
    default:
      throw new Error(`recordingMutations: unsupported fieldName "${field}"`);
  }
};
