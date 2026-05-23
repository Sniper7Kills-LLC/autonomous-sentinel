import type { LinguisticAttempt, LinguisticProvider } from './attempts';

/**
 * Linguistic Logic reprocess-on-bump selection helpers (#66).
 *
 * When an admin activates a new prompt version (#64), exactly the
 * Recordings that previously failed parsing should be re-run.
 * Recordings with any prior successful attempt — at any version —
 * are explicitly skipped. From CLAUDE.md → Pipeline components →
 * Linguistic Logic:
 *
 *   "Bumping prompt_version re-processes ONLY previously-failed
 *    recordings (not successful ones)."
 *
 * Re-running on a previously-successful Recording would either
 * silently overwrite published Message data or generate noisy
 * revisions on entries that were already correct. The new prompt
 * is an opportunity to catch previously-unparseable recordings;
 * it is NOT a signal to re-derive existing Messages.
 *
 * Pure JS. The reprocess driver Lambda (deferred) Scans Recordings
 * with `parseFailed=true`, passes each row's `linguisticAttempts`
 * through `shouldReprocess`, and on `true` enqueues the SQS
 * message built by `buildReprocessMessage`.
 *
 * Dedup belt-and-braces: even if a Recording is somehow enqueued
 * twice, the `shouldSkip` check from #64's `attempts.ts` short-
 * circuits the second invocation when `(provider, promptVersion,
 * promptHash)` already has a successful attempt logged.
 */

/** Reasons a reprocess gets enqueued — recorded on the SQS body. */
export const ReprocessReason = {
  PROMPT_VERSION_BUMP: 'prompt-version-bump',
  MANUAL_RETRIGGER: 'manual-retrigger',
} as const;
export type ReprocessReason = (typeof ReprocessReason)[keyof typeof ReprocessReason];

export interface ReprocessCandidate {
  id: string;
  linguisticAttempts?: LinguisticAttempt[] | null;
  /**
   * Soft-delete marker from the Recording model. The driver
   * filters at Scan time but the selector double-checks so a
   * stale fixture in tests can't slip through.
   */
  deletedAt?: string | null;
  /**
   * Sentinel set by the linguistic Lambda when a prior run
   * failed to parse. The driver filters at Scan time via this
   * field; the selector trusts it but does NOT require it
   * (the attempts-log check is the authoritative gate).
   */
  parseFailed?: boolean | null;
}

export interface ReprocessMessage {
  recordingId: string;
  reason: ReprocessReason;
  promptVersion: number;
  enqueuedAt: string;
}

interface ShouldReprocessOpts {
  /**
   * Provider we care about. Reprocess-on-bump targets the
   * Bedrock fallback path (#63); the rules engine (#62)
   * isn't gated by prompt version in the same way. Default
   * `'bedrock'`.
   */
  provider?: LinguisticProvider;
}

/**
 * Decides whether the given Recording should be re-enqueued on a
 * prompt-version bump.
 *
 * Returns `false` (skip) when:
 *   - The Recording is soft-deleted (`deletedAt` set).
 *   - The attempts log has ANY successful entry at any version,
 *     any provider (CLAUDE.md "never re-run on previously
 *     successful recordings"). This is intentionally more
 *     conservative than a per-version compare: a Bedrock success
 *     AT ALL means there is a published Message; re-deriving it
 *     under a new prompt risks silent overwrite or noisy
 *     revisions, regardless of which version produced it.
 *   - The attempts log has failures only on a different provider
 *     (a Bedrock bump can't fix rules-only failures). The
 *     `newPromptVersion` parameter is currently informational
 *     only — it rides the SQS message via
 *     `buildReprocessMessage` so the consumer's `attempts.ts`
 *     `shouldSkip` dedup (#64) can match on `(provider, version,
 *     hash)`. The selector itself does not gate on the version
 *     number; the conservative success guard subsumes that need.
 *
 * Returns `true` (enqueue) when:
 *   - The Recording has at least one failed attempt for the target
 *     provider AND no successful entry at all.
 *   - The Recording has no attempts logged AND `parseFailed=true`
 *     (a Recording that hit the DLQ before any attempt could be
 *     written — rare, but the driver picks them up too).
 */
export function shouldReprocess(
  candidate: ReprocessCandidate,
  newPromptVersion: number,
  opts: ShouldReprocessOpts = {},
): boolean {
  if (candidate.deletedAt) return false;

  const provider: LinguisticProvider = opts.provider ?? 'bedrock';
  const attempts = Array.isArray(candidate.linguisticAttempts) ? candidate.linguisticAttempts : [];

  // Hard guard: any successful attempt at any version, any
  // provider, means the Recording already has a published Message
  // — never re-run.
  if (attempts.some((a) => a.success === true)) return false;

  // No attempts logged + parseFailed sentinel: pre-attempt-log
  // crash. Enqueue so the new version gets a chance.
  if (attempts.length === 0) {
    return candidate.parseFailed === true;
  }

  // Has attempts but none succeeded. Enqueue only if there is at
  // least one failed entry for the target provider — otherwise
  // the Recording's failures are on a different path (rules)
  // and a Bedrock bump can't help.
  return attempts.some((a) => a.provider === provider && a.success === false);
}

interface BuildOpts {
  now?: () => Date;
}

/**
 * Builds the SQS message body for a single reprocess enqueue.
 * `enqueuedAt` is ISO 8601 UTC, sourced from `opts.now` when
 * provided (tests) else `Date.now`.
 */
export function buildReprocessMessage(
  recordingId: string,
  reason: ReprocessReason,
  promptVersion: number,
  opts: BuildOpts = {},
): ReprocessMessage {
  const enqueuedAt = (opts.now ?? (() => new Date()))().toISOString();
  return { recordingId, reason, promptVersion, enqueuedAt };
}

export interface SelectOpts extends ShouldReprocessOpts {
  /**
   * Hard cap on the number of candidates returned per driver
   * invocation. Defaults to `Infinity` (no cap). The driver sets
   * this to e.g. 1000 per batch so a multi-million-row Scan
   * doesn't try to enqueue everything in a single Lambda
   * invocation. The driver's pagination loop carries the rest.
   */
  limit?: number;
}

/**
 * Filters a candidate batch (one Scan page) down to the Recordings
 * that should be enqueued. Caller invokes per page and respects
 * the `LastEvaluatedKey` cursor; this helper is intentionally
 * page-agnostic so it can be unit-tested against an in-memory
 * fixture array.
 */
export function selectForReprocess(
  candidates: ReprocessCandidate[],
  newPromptVersion: number,
  opts: SelectOpts = {},
): ReprocessCandidate[] {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const out: ReprocessCandidate[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (shouldReprocess(c, newPromptVersion, opts)) out.push(c);
  }
  return out;
}
