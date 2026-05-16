import type { Handler, ScheduledEvent } from 'aws-lambda';
import {
  QueryCommand,
  type AttributeValue,
  type QueryCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  fanOutLegacyFks,
  type FanOutDeps,
  type FanOutSummary,
  type TableKey,
} from '../legacyClaimWorker/fan-out-legacy-fks';
import {
  defaultFanOutQuery,
  defaultFanOutTableNames,
  defaultFanOutTransact,
  getDdbClient,
} from '../legacyClaimWorker/fan-out-production';
import { audit as defaultAudit } from '../../data/audit-log-helper';

/**
 * `legacyClaimReplaySweeper` — daily EventBridge cron that finishes any
 * legacy-claim work that the per-signup `legacyClaimWorker` (#272 / #273)
 * didn't complete (sub-C of #16, #274).
 *
 * Failure modes the sweeper covers:
 *   - Worker async-invoke retry exhausted (DLQ landed but never replayed).
 *   - Worker invoked but crashed after `linkLegacyClaim` succeeded and
 *     before / partway through `fanOutLegacyFks`.
 *   - Backend / IAM regression that briefly blocked the worker's writes.
 *
 * Strategy:
 *   1. Query `User` by GSI `claimStatus = CLAIMED` (sparse — only
 *      claimed rows index).
 *   2. For each, fetch its `USER_CLAIM` + `USER_CLAIM_FANOUT` audit
 *      entries (keyed by the new sub as `targetId`).
 *   3. Group by `claimId`. Build the `completedTables` set from every
 *      `USER_CLAIM_FANOUT` entry's `after.table`.
 *   4. Invoke `fanOutLegacyFks` with `getCompletedTables(claimId)` so
 *      the helper skips any table already done. Rows with FKs already
 *      pointing at `newSub` would no-op on the Query anyway, but the
 *      manifest-skip saves the per-table Query cost.
 *
 * A run iterates every CLAIMED user. One user failing does not block
 * the others — the catch wraps each user's fan-out so a bad row
 * doesn't poison the sweep.
 *
 * Idempotency:
 *   - Same sweeper invocation, same user: deterministic — the
 *     manifest-skip + Query both filter already-done state.
 *   - Sweeper running while the per-signup worker is also running for
 *     the same user: both call the same fan-out helper which is
 *     idempotent at the row level. Worst case is two concurrent
 *     transacts on disjoint rows.
 *
 * Known trade-offs (acceptable for v1; documented for future work):
 *   - **N+1 audit queries.** `listAuditForTarget` runs once per
 *     CLAIMED user. For a backlog of N CLAIMED users this is N
 *     audit-table Queries. Acceptable while the legacy backlog is
 *     bounded; revisit if the sweeper starts dominating its own
 *     Lambda budget.
 *   - **No concurrency guard.** EventBridge daily cron should never
 *     double-fire, but a manual retrigger or misconfigured rule could
 *     have two sweepers racing. Row-level idempotency keeps data safe
 *     (the fan-out helper no-ops on rows whose FK already equals
 *     newSub); the only cost is duplicate work. If the rate becomes
 *     observable, add a lease via DDB conditional-write on a sentinel
 *     row.
 */

export interface ClaimedUserRow {
  cognitoSub: string;
  email?: string | null;
  legacyEmail?: string | null;
  legacyUserId?: number | null;
  claimStatus?: string | null;
  [k: string]: unknown;
}

/**
 * Subset of an AuditLog row this handler reads. `after` is `a.json()` on
 * the model so it surfaces as an arbitrary record at runtime.
 */
export interface AuditEntry {
  // Subset of `AuditAction` the sweeper actually cares about; widened
  // to `string` so the helper can ignore unrelated entries without a
  // narrowing dance.
  action: string;
  claimId?: string | null;
  after?: { table?: string } | null;
}

export interface ListClaimedInput {
  /** Pagination cursor; production should loop until empty. */
  nextToken?: string;
}
export interface ListClaimedResult {
  items: ClaimedUserRow[];
  nextToken?: string;
}

export interface ListAuditInput {
  /** AuditLog `targetId` — the User row's cognitoSub. */
  targetId: string;
}
export interface ListAuditResult {
  items: AuditEntry[];
}

/**
 * Signature of the fan-out runner — same shape as `fanOutLegacyFks`
 * itself; the sweeper hands its own `getCompletedTables` callback in
 * via `args.deps`.
 */
export type RunFanOutFn = (args: {
  oldSub: string;
  newSub: string;
  claimId: string;
  deps: FanOutDeps;
}) => Promise<FanOutSummary>;

export interface SweeperDeps {
  listClaimedUsers: (input: ListClaimedInput) => Promise<ListClaimedResult>;
  listAuditForTarget: (input: ListAuditInput) => Promise<ListAuditResult>;
  runFanOut: RunFanOutFn;
  /**
   * Optional fan-out deps the sweeper passes through to `runFanOut` when
   * production resolves the DDB SDK shim. Tests pass `runFanOut` as
   * `vi.fn` and ignore this field.
   */
  fanOutDeps?: Omit<FanOutDeps, 'getCompletedTables'>;
}

let injected: Partial<SweeperDeps> = {};

export function __setDeps(deps: Partial<SweeperDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

function deriveOldSub(row: ClaimedUserRow): string | null {
  if (typeof row.legacyUserId === 'number') {
    return `legacy:${row.legacyUserId}`;
  }
  return null;
}

function pickClaimId(entries: AuditEntry[]): string | null {
  for (const e of entries) {
    if (e.action === 'USER_CLAIM' && typeof e.claimId === 'string' && e.claimId) {
      return e.claimId;
    }
  }
  return null;
}

function completedTablesFor(claimId: string, entries: AuditEntry[]): Set<TableKey> {
  const out = new Set<TableKey>();
  for (const e of entries) {
    if (
      e.action === 'USER_CLAIM_FANOUT' &&
      e.claimId === claimId &&
      typeof e.after?.table === 'string'
    ) {
      out.add(e.after.table as TableKey);
    }
  }
  return out;
}

function defaultUserTableName(): string {
  const v = process.env.USER_TABLE_NAME;
  if (!v) {
    throw new Error('legacyClaimReplaySweeper: USER_TABLE_NAME env var is required');
  }
  return v;
}

function defaultAuditLogTableName(): string {
  const v = process.env.AUDIT_LOG_TABLE_NAME;
  if (!v) {
    throw new Error('legacyClaimReplaySweeper: AUDIT_LOG_TABLE_NAME env var is required');
  }
  return v;
}

/**
 * Production lister: Query the User table by `claimStatus` GSI for
 * `claimStatus = 'CLAIMED'` rows. Sparse GSI — only claimed rows
 * index, so the partition is bounded and the per-call DDB cost is
 * small even on a busy day.
 */
async function defaultListClaimedUsers(input: ListClaimedInput): Promise<ListClaimedResult> {
  const exclusiveStartKey: Record<string, AttributeValue> | undefined = input.nextToken
    ? (JSON.parse(input.nextToken) as Record<string, AttributeValue>)
    : undefined;
  const res: QueryCommandOutput = await getDdbClient().send(
    new QueryCommand({
      TableName: defaultUserTableName(),
      IndexName: 'user-claimStatus-index',
      KeyConditionExpression: '#cs = :cs',
      ExpressionAttributeNames: { '#cs': 'claimStatus' },
      ExpressionAttributeValues: marshall({ ':cs': 'CLAIMED' }),
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );
  const items: ClaimedUserRow[] = [];
  if (res.Items) {
    for (const raw of res.Items) {
      items.push(unmarshall(raw) as ClaimedUserRow);
    }
  }
  return {
    items,
    nextToken: res.LastEvaluatedKey ? JSON.stringify(res.LastEvaluatedKey) : undefined,
  };
}

/**
 * Production audit lister: Query AuditLog by the `(targetType,
 * targetId)` GSI introduced in #274 so the sweeper reads exactly the
 * entries for one User row. Caller filters by `claimId` in-memory.
 */
async function defaultListAuditForTarget(input: ListAuditInput): Promise<ListAuditResult> {
  const items: AuditEntry[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
  do {
    const res: QueryCommandOutput = await getDdbClient().send(
      new QueryCommand({
        TableName: defaultAuditLogTableName(),
        IndexName: 'auditLog-targetType-index',
        KeyConditionExpression: '#tt = :tt AND #ti = :ti',
        ExpressionAttributeNames: { '#tt': 'targetType', '#ti': 'targetId' },
        ExpressionAttributeValues: marshall({ ':tt': 'User', ':ti': input.targetId }),
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (res.Items) {
      for (const raw of res.Items) {
        items.push(unmarshall(raw) as AuditEntry);
      }
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return { items };
}

/**
 * Production fan-out runner: defer straight to `fanOutLegacyFks` with
 * the same DDB-backed deps the per-signup worker uses. The sweeper
 * adds its own `getCompletedTables` via the call-site, so this
 * runner only fills the static fan-out config.
 */
const defaultRunFanOut: RunFanOutFn = (args) => fanOutLegacyFks(args);

function defaultFanOutDeps(): Omit<FanOutDeps, 'getCompletedTables'> {
  return {
    tableNames: defaultFanOutTableNames(defaultUserTableName()),
    query: defaultFanOutQuery,
    transact: defaultFanOutTransact,
    audit: (ctx, opts) => defaultAudit(ctx, opts),
  };
}

function resolveDeps(): SweeperDeps {
  const runFanOut = injected.runFanOut ?? defaultRunFanOut;
  // Only resolve production fan-out deps when the production
  // `runFanOut` is active — `defaultFanOutDeps()` reads env vars that
  // tests don't set, so calling it when a stubbed `runFanOut` is in
  // play would throw on every test invocation.
  const fanOutDeps = injected.fanOutDeps ?? (injected.runFanOut ? undefined : defaultFanOutDeps());
  return {
    listClaimedUsers: injected.listClaimedUsers ?? defaultListClaimedUsers,
    listAuditForTarget: injected.listAuditForTarget ?? defaultListAuditForTarget,
    runFanOut,
    fanOutDeps,
  };
}

export const handler: Handler<ScheduledEvent, void> = async () => {
  const deps = resolveDeps();

  let nextToken: string | undefined;
  do {
    const page = await deps.listClaimedUsers({ nextToken });
    for (const user of page.items) {
      try {
        const oldSub = deriveOldSub(user);
        if (!oldSub) {
          console.warn('legacyClaimReplaySweeper: CLAIMED row missing legacyUserId; skipping', {
            newSub: user.cognitoSub,
          });
          continue;
        }
        const audits = await deps.listAuditForTarget({ targetId: user.cognitoSub });
        const claimId = pickClaimId(audits.items);
        if (!claimId) {
          console.warn(
            'legacyClaimReplaySweeper: CLAIMED row has no USER_CLAIM audit entry — cannot derive claimId; skipping',
            { newSub: user.cognitoSub },
          );
          continue;
        }
        const completed = completedTablesFor(claimId, audits.items);
        const summary = await deps.runFanOut({
          oldSub,
          newSub: user.cognitoSub,
          claimId,
          deps: {
            // Pass-through fan-out config (production fills this from
            // backend wiring; tests stub `runFanOut` itself and ignore
            // these fields).
            ...deps.fanOutDeps,
            getCompletedTables: () => Promise.resolve(completed),
          } as FanOutDeps,
        });
        console.info('legacyClaimReplaySweeper: ran fan-out replay', {
          newSub: user.cognitoSub,
          claimId,
          completedTables: Array.from(completed),
          summary,
        });
      } catch (err) {
        // Per-user failure is logged; sweep continues on the next user
        // so one bad row doesn't block the rest of the manifest.
        console.error('legacyClaimReplaySweeper: per-user fan-out failed', {
          newSub: user.cognitoSub,
          err,
        });
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
};
