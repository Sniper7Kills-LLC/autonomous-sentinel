/**
 * Recording pipeline status ordering + monotonic guards (#741).
 *
 * The pipeline advances a Recording QUEUED → PREPROCESSING → TRANSCRIBING
 * → PARSING → PUBLISHED, with `*_FAILED` / `FAILED` as terminal failure
 * states. Every stage writes the status via Amplify Data
 * (`client.models.Recording.update`) so AppSync's subscription publisher
 * fires for the My Uploads portal — which means there is NO DynamoDB
 * `ConditionExpression` protecting against a stray / duplicate SQS
 * delivery (standard queues are at-least-once) re-running a stage on an
 * already-advanced recording and regressing its status.
 *
 * These helpers let each stage cheaply guard itself with a read-then-check
 * (the recording is already fetched on most stage paths): a stage skips
 * its work when the recording has already reached or passed that stage's
 * output status. The check is advisory (a sub-second TOCTOU race remains
 * vs a true conditional write), but it closes the realistic duplicate /
 * redrive window without abandoning the subscription-firing Amplify Data
 * write. Admin reprocess intentionally resets the row to QUEUED first, so
 * a legitimate re-run is never blocked by these guards.
 */

/** Forward (non-failure) status ladder, in order. */
export const RECORDING_STATUS_ORDER = [
  'QUEUED',
  'PREPROCESSING',
  'TRANSCRIBING',
  'PARSING',
  'PUBLISHED',
] as const;

export type ForwardRecordingStatus = (typeof RECORDING_STATUS_ORDER)[number];

/** Terminal states — once reached, no pipeline stage may move the row. */
export const TERMINAL_RECORDING_STATUSES = new Set<string>([
  'PUBLISHED',
  'PREPROCESS_FAILED',
  'TRANSCRIBE_FAILED',
  'PARSE_FAILED',
  'FAILED',
]);

export function isTerminalRecordingStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_RECORDING_STATUSES.has(status);
}

/**
 * Rank of a forward status (index in the ladder). Unknown values and
 * failure states return -1 — they are handled via {@link isTerminalRecordingStatus}
 * rather than the ordinal compare.
 */
export function forwardStatusRank(status: unknown): number {
  if (typeof status !== 'string') return -1;
  return (RECORDING_STATUS_ORDER as readonly string[]).indexOf(status);
}

/**
 * True when `current` has already reached or passed `target` on the
 * forward ladder, OR is terminal. A stage whose output status is `target`
 * uses this to skip redundant / regressive re-runs:
 *
 *   if (hasReachedStatus(current, 'TRANSCRIBING')) return;  // preprocess
 *
 * Non-terminal earlier states (or an unknown/null current) return false →
 * the stage proceeds. A null/unknown current is treated as "fresh"
 * (proceed) so a brand-new recording is never skipped.
 */
export function hasReachedStatus(current: unknown, target: ForwardRecordingStatus): boolean {
  if (isTerminalRecordingStatus(current)) return true;
  const cur = forwardStatusRank(current);
  if (cur < 0) return false;
  return cur >= forwardStatusRank(target);
}
