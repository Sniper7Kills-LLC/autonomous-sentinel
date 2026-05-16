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
 * Cascade-delete: per CLAUDE.md, "messages with no recording cease
 * to exist". After the Recording row is soft-deleted, the handler
 * Queries siblings by `messageId` and counts live rows. If none
 * remain, it soft-deletes the parent Message + emits a
 * `MESSAGE_DELETE` audit entry tagged with
 * `reason='cascade — last recording deleted'`, system actor.
 *
 * Deferred (out of scope, tracked separately):
 *   - **S3 hard-delete** of the original / web-canonical / sidecar
 *     keys. Phase 3 / storage lifecycle work — versioning
 *     preserves the 30-day undo window.
 *
 * Returns the post-mutation Recording row.
 */

export type RecordingRow = {
  id: string;
  messageId?: string | null;
  contentHash?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  [k: string]: unknown;
};

export type MessageRow = {
  id: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletedReason?: string | null;
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
      /**
       * GSI lookup auto-generated for `i('messageId')` (added in
       * #29). Returns sibling recordings keyed on the same Message.
       * The cascade-delete check filters out already-deleted rows
       * in-handler.
       */
      listRecordingByMessageId: (input: { messageId: string }) => Promise<{
        data: RecordingRow[] | null;
        errors?: unknown;
      }>;
    };
    Message: {
      get: (input: { id: string }) => Promise<{ data: MessageRow | null; errors?: unknown }>;
      update: (
        input: Partial<MessageRow> & { id: string },
      ) => Promise<{ data: MessageRow | null; errors?: unknown }>;
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

function snapshot<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return { ...row };
}

/**
 * Cascade-delete the parent Message when the just-deleted Recording
 * was the last live child. Idempotent: if the parent is already
 * deleted (concurrent admin click or replay) we skip the rewrite +
 * the audit so the manifest stays clean.
 */
async function cascadeDeleteMessageIfOrphaned(
  parentMessageId: string,
  deps: {
    client: RecordingMutationsDataClient;
    audit: AuditFn;
    now: () => Date;
  },
  auditCtx: AuditContext,
): Promise<void> {
  const siblings = await deps.client.models.Recording.listRecordingByMessageId({
    messageId: parentMessageId,
  });
  const liveRows = (siblings.data ?? []).filter((r) => !r.deletedAt);
  if (liveRows.length > 0) {
    return;
  }

  const fetched = await deps.client.models.Message.get({ id: parentMessageId });
  const before = fetched.data;
  if (!before) {
    // Message was already hard-removed or never existed — nothing to
    // cascade onto. Log + return silently.
    console.warn('softDeleteRecording: parent Message not found; skipping cascade', {
      parentMessageId,
    });
    return;
  }
  if (before.deletedAt) {
    return;
  }

  const now = deps.now().toISOString();
  const cascadeReason = 'cascade — last recording deleted';
  const patch: Partial<MessageRow> & { id: string } = {
    id: parentMessageId,
    deletedAt: now,
    deletedBy: null,
    deletedReason: cascadeReason,
  };
  const updated = await deps.client.models.Message.update(patch);
  if (updated.errors) {
    throw new Error(
      `softDeleteRecording: cascade Message.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  // System-actor audit: the moderator's call deleted the Recording;
  // the Message delete is automatic. `identity` is null on the audit
  // ctx so `actorId` lands as null in the row.
  await deps.audit(
    { identity: null, request: auditCtx.request },
    {
      action: 'MESSAGE_DELETE',
      targetType: 'Message',
      targetId: parentMessageId,
      before: snapshot(before),
      after: snapshot(after),
      reason: cascadeReason,
    },
  );
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

  const auditCtx = auditContextFrom(event);
  await deps.audit(auditCtx, {
    action: 'RECORDING_DELETE',
    targetType: 'Recording',
    targetId,
    before: snapshot(before),
    after: snapshot(after),
    reason: normalisedReason,
  });

  // Cascade: if this was the last live Recording on the parent
  // Message, soft-delete the Message too ("messages with no
  // recording cease to exist" per CLAUDE.md).
  if (typeof before.messageId === 'string' && before.messageId.length > 0) {
    await cascadeDeleteMessageIfOrphaned(before.messageId, deps, auditCtx);
  }

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
