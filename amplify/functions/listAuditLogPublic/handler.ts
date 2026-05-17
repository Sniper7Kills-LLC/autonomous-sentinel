import type { AppSyncResolverHandler } from 'aws-lambda';
import type { AuditAction } from '../../data/audit-log-helper';

/**
 * `listAuditLogPublic` — PII-filtered AuditLog read for guest +
 * authenticated callers (#38).
 *
 * Replaces the prior broad `allow.guest().to(['read'])` +
 * `allow.authenticated().to(['read'])` on the AuditLog model (same
 * pattern as the User PR #269 lockdown that moved public reads to
 * `getUserPublic`).
 *
 * Filtering policy:
 *
 *   - **Content-mutation actions** (MESSAGE_*, RECORDING_*,
 *     COMMENT_DELETE, TRANSMITTER_*) → visible to everyone. Anyone
 *     looking at a Message / Recording / Comment / Transmitter has a
 *     legitimate interest in knowing whether it was edited / deleted
 *     / restored and by whom.
 *
 *   - **USER_* actions** (BAN / UNBAN / ROLE_CHANGE / PII_BLANK /
 *     CLAIM / CLAIM_FANOUT) → only visible to the actor or the
 *     target. Bans + role changes leak moderator decisions; PII
 *     blanks + claims leak account state. Both are private outside
 *     the actor / target / admin / mod roles.
 *
 *   - **Internal actions** (BUDGET_THRESHOLD_UPDATE, REP_FORMULA_UPDATE,
 *     CALLSIGN_MERGE, LINGUISTIC_CONFIG_UPDATE, PROMPT_VERSION_BUMP,
 *     BAN_REGION_PAGE_UPDATE, FIELDVOTE_ORPHAN_SWEEP) → admin / mod
 *     only.
 *
 *   - **Admin / moderator callers** see every entry the underlying
 *     Query returns; the filter is a no-op for elevated groups.
 *
 * Input requires both `targetType` and `targetId` so the underlying
 * Query hits the `(targetType, targetId)` GSI without a full table
 * scan. Callers that want the full ban-log etc. should use the
 * elevated admin-only direct read path against the model.
 */

export type AuditLogRow = {
  id: string;
  // Widened to `string` so unknown actions (future enum additions
  // landing before this file's import is refreshed) don't crash the
  // filter — they just stay invisible to non-admin/mod callers.
  action: string;
  targetType: string;
  targetId: string;
  actorId?: string | null;
  diff?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  claimId?: string | null;
  [k: string]: unknown;
};

export interface AuditLogPublicDataClient {
  listByTargetTypeAndTargetId: (input: {
    targetType: string;
    targetId: string;
    limit?: number;
    nextToken?: string;
  }) => Promise<{ items: AuditLogRow[]; nextToken?: string }>;
}

let injected: Partial<AuditLogPublicDataClient> = {};

export function __setDeps(deps: Partial<AuditLogPublicDataClient>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

/**
 * Actions visible to everyone, no actor/target gate.
 */
export const PUBLIC_AUDIT_ACTIONS: readonly AuditAction[] = [
  'MESSAGE_DELETE',
  'MESSAGE_RESTORE',
  'MESSAGE_EDIT',
  'RECORDING_DELETE',
  'RECORDING_RESTORE',
  'COMMENT_DELETE',
  'TRANSMITTER_CREATE',
  'TRANSMITTER_UPDATE',
  'TRANSMITTER_DELETE',
];

/**
 * Actions visible to the actor or the target row (plus admin / mod).
 * Everything else is admin / mod only.
 */
const USER_TARGETED_ACTIONS: readonly AuditAction[] = [
  'USER_BAN',
  'USER_UNBAN',
  'USER_ROLE_CHANGE',
  'USER_PII_BLANK',
  'USER_CLAIM',
  'USER_CLAIM_FANOUT',
];

function isElevatedCaller(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf('admin') >= 0 || groups.indexOf('moderator') >= 0;
}

function callerSub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function passesFilter(row: AuditLogRow, caller: string | null, elevated: boolean): boolean {
  if (elevated) return true;
  if (PUBLIC_AUDIT_ACTIONS.indexOf(row.action as AuditAction) >= 0) {
    return true;
  }
  if (USER_TARGETED_ACTIONS.indexOf(row.action as AuditAction) >= 0) {
    if (!caller) return false;
    if (row.actorId === caller) return true;
    if (row.targetId === caller) return true;
    return false;
  }
  // Anything not in either list is internal admin tooling — gated to
  // admin / mod above.
  return false;
}

interface PublicAuditQueryArgs {
  targetType?: string;
  targetId?: string;
  limit?: number;
  nextToken?: string;
}

interface PublicAuditQueryResult {
  items: AuditLogRow[];
  nextToken?: string;
}

async function getClient(): Promise<AuditLogPublicDataClient> {
  if (injected.listByTargetTypeAndTargetId) {
    return { listByTargetTypeAndTargetId: injected.listByTargetTypeAndTargetId };
  }
  const mod = await import('aws-amplify/data');
  const client = mod.generateClient({ authMode: 'iam' }) as unknown as {
    models: {
      AuditLog: {
        listAuditLogByTargetTypeAndTargetId: (input: {
          targetType: string;
          targetId: string;
          limit?: number;
          nextToken?: string;
        }) => Promise<{ data: AuditLogRow[] | null; nextToken?: string; errors?: unknown }>;
      };
    };
  };
  return {
    listByTargetTypeAndTargetId: async ({ targetType, targetId, limit, nextToken }) => {
      const res = await client.models.AuditLog.listAuditLogByTargetTypeAndTargetId({
        targetType,
        targetId,
        limit,
        nextToken,
      });
      return { items: res.data ?? [], nextToken: res.nextToken };
    },
  };
}

export const handler: AppSyncResolverHandler<PublicAuditQueryArgs, PublicAuditQueryResult> = async (
  event,
) => {
  const { targetType, targetId, limit, nextToken } = event.arguments;
  if (!targetType || !targetId) {
    // Bare list of the whole AuditLog would scan + return a firehose
    // of rows that the filter then mostly drops. Force callers to
    // scope to a single (targetType, targetId).
    throw new Error('listAuditLogPublic: targetType + targetId arguments are required');
  }

  const client = await getClient();
  const res = await client.listByTargetTypeAndTargetId({
    targetType,
    targetId,
    limit,
    nextToken,
  });

  const caller = callerSub(event.identity);
  const elevated = isElevatedCaller(event.identity);
  const items = res.items.filter((row) => passesFilter(row, caller, elevated));

  return { items, nextToken: res.nextToken };
};
