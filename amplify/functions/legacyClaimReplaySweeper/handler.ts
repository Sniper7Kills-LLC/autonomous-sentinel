import type { Handler, ScheduledEvent } from 'aws-lambda';
import type { FanOutDeps, FanOutSummary, TableKey } from '../legacyClaimWorker/fan-out-legacy-fks';

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

function resolveDeps(): SweeperDeps {
  if (!injected.listClaimedUsers || !injected.listAuditForTarget || !injected.runFanOut) {
    // Production wiring (DDB SDK) is deferred to a follow-up that ties
    // the sweeper to the same Amplify Data client the worker uses.
    // Tests always inject via `__setDeps` so this never throws there.
    throw new Error('legacyClaimReplaySweeper: deps not injected — production wiring pending');
  }
  return {
    listClaimedUsers: injected.listClaimedUsers,
    listAuditForTarget: injected.listAuditForTarget,
    runFanOut: injected.runFanOut,
    fanOutDeps: injected.fanOutDeps,
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
