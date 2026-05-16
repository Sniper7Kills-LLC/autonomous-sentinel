/**
 * `linkLegacyClaim` — User-row PK rewrite half of the legacy-claim flow
 * (sub-A of #16, tracked at #272).
 *
 * Pre-seeded migration rows hold `cognitoSub = "legacy:<legacyUserId>"`
 * until the matching v3 user signs up. DynamoDB does not allow updating
 * a partition key in place, so the rewrite has to delete-old + put-new
 * inside a `TransactWriteItems` call so the row either fully exists at
 * the real Cognito sub or stays at the legacy placeholder. No half-state.
 *
 * Scope here is the User row only — child rows in 11 FK tables (Sdr,
 * Comment, AbuseReport, FieldVote, RevisionVote, Donation,
 * NotificationPreference, Recording, TranscriptRevision, Reputation,
 * User.bannedById) still point at the legacy placeholder after this
 * runs. PR B (#273) fans the rewrite out across those tables; PR C
 * (#274) handles partial-state replay using the `claimId` threaded
 * through every audit entry.
 *
 * The helper is dependency-injected so unit tests stub the DDB
 * transactor + audit emitter without spinning up the SDK. Production
 * wiring lives in `handler.ts`.
 */

import type { AuditAction, AuditContext, AuditOptions } from '../../data/audit-log-helper';

/**
 * Subset of the User row this helper actually touches. The handler may
 * pass a wider object; everything except the explicitly-named columns
 * is copied through verbatim via the index signature.
 */
export interface LegacyUserRow {
  cognitoSub: string;
  email?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  legacyUserId?: number | null;
  legacyEmail?: string | null;
  claimStatus?: string | null;
  claimedAt?: string | null;
  piiBlanked?: boolean | null;
  [k: string]: unknown;
}

/**
 * Shape passed to the injected DDB transactor. Production satisfies
 * this with a `TransactWriteCommand` wrapping a `Delete` on `oldPk`
 * plus a `Put` on `newRow`, both against `tableName`. The helper
 * stays SDK-agnostic so tests do not need to model the DDB shape.
 */
export interface TransactPkRewriteInput {
  tableName: string;
  oldPk: { cognitoSub: string };
  newRow: LegacyUserRow;
}

/**
 * Allow the audit helper to take an optional `claimId` so the cross-
 * table manifest threaded through PRs A/B/C can correlate every entry
 * from a single claim. The base `AuditOptions` doesn't carry it; we
 * extend here to keep that contract explicit at the call site.
 */
export interface ClaimAuditOptions extends AuditOptions {
  action: Extract<AuditAction, 'USER_CLAIM'>;
  claimId: string;
}

export type ClaimAuditFn = (ctx: AuditContext, opts: ClaimAuditOptions) => Promise<string>;

export interface LegacyClaimDeps {
  tableName: string;
  transact: (input: TransactPkRewriteInput) => Promise<void>;
  audit: ClaimAuditFn;
  now: () => Date;
  newClaimId: () => string;
}

export interface LinkLegacyClaimArgs {
  legacyRow: LegacyUserRow;
  realSub: string;
  deps: LegacyClaimDeps;
  /**
   * Caller-provided audit context (identity + request headers).
   * Defaults to a system actor (`identity: null`) so the post-confirm
   * Lambda — which has no AppSync identity claims of its own — still
   * emits an attributable audit row.
   */
  auditContext?: AuditContext;
  /**
   * Pre-generated claim id. Workflows that thread the same `claimId`
   * across multiple audit entries (#273 fan-out, #274 replay) generate
   * it once at the top of the flow and pass it through here so the
   * `USER_CLAIM` entry shares the manifest key. If omitted, the helper
   * falls back to `deps.newClaimId()`.
   */
  claimId?: string;
}

const LEGACY_PK_PREFIX = 'legacy:';

function snapshot(row: LegacyUserRow): Record<string, unknown> {
  return { ...row };
}

/**
 * Atomically rewrite the User row PK from `legacy:<id>` to `realSub`
 * and emit a `USER_CLAIM` audit entry.
 *
 * Idempotent: if the legacy row is already `CLAIMED` (e.g. Cognito
 * retry hit a row PR B already wrote), the helper short-circuits and
 * returns the row untouched. The PR-C replay path inspects the audit
 * manifest to decide whether the fan-out finished — that lookup
 * doesn't happen here.
 */
export async function linkLegacyClaim(args: LinkLegacyClaimArgs): Promise<LegacyUserRow> {
  const { legacyRow, realSub, deps, auditContext } = args;

  // Already-claimed short-circuit. Detect on the row's claim status
  // rather than the PK shape because a CLAIMED row's PK is already
  // the real sub.
  if (legacyRow.claimStatus === 'CLAIMED') {
    return legacyRow;
  }

  // Guard: this helper only rewrites placeholder rows. A real sub PK
  // arriving here would mean the caller mis-routed a fresh-signup row
  // into the claim path — silently rewriting it would orphan its FKs.
  if (!legacyRow.cognitoSub.startsWith(LEGACY_PK_PREFIX)) {
    throw new Error(
      `linkLegacyClaim: legacyRow.cognitoSub must start with "${LEGACY_PK_PREFIX}"; got "${legacyRow.cognitoSub}"`,
    );
  }

  const claimedAt = deps.now().toISOString();
  const claimId = args.claimId ?? deps.newClaimId();

  const newRow: LegacyUserRow = {
    ...legacyRow,
    cognitoSub: realSub,
    claimStatus: 'CLAIMED',
    claimedAt,
  };

  // Atomic PK rewrite. Failure throws and skips the audit write so
  // the manifest never claims a step that didn't run.
  await deps.transact({
    tableName: deps.tableName,
    oldPk: { cognitoSub: legacyRow.cognitoSub },
    newRow,
  });

  await deps.audit(auditContext ?? { identity: null, request: { headers: {} } }, {
    action: 'USER_CLAIM',
    targetType: 'User',
    targetId: realSub,
    before: snapshot(legacyRow),
    after: snapshot(newRow),
    claimId,
  });

  return newRow;
}
