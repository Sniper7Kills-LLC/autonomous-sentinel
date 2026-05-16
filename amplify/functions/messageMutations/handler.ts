import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for the `softDeleteMessage` custom
 * mutation (#28). Mirrors the `banUser` shape from `userMutations`
 * so the cross-cutting AuditLog helper (#258) stays the sole writer
 * of the `MESSAGE_DELETE` row.
 *
 * Dispatches on `event.info.fieldName`:
 *   - `softDeleteMessage` — admin-only. Sets `deletedAt` / `deletedBy`
 *     / `deletedReason` on the target Message. Idempotent — a second
 *     call on an already-deleted row returns the row untouched.
 *
 * Returns the post-mutation Message row.
 */

export type MessageRow = {
  id: string;
  body?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletedReason?: string | null;
  [k: string]: unknown;
};

export interface MessageMutationsDataClient {
  models: {
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
    default:
      throw new Error(`messageMutations: unsupported fieldName "${field}"`);
  }
};
