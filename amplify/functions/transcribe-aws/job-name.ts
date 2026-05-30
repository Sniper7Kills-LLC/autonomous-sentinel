/**
 * Amazon Transcribe job-name encode / decode (#585).
 *
 * Transcribe job names must be unique per account/region and are
 * constrained to `[0-9a-zA-Z._-]{1,200}`. We encode the recordingId
 * into the job name so the async finalizer Lambda (triggered by the
 * `aws.transcribe` "Transcribe Job State Change" EventBridge event,
 * which carries the job name but NOT our recordingId) can recover
 * which Recording a finished job belongs to.
 *
 * Format: `eam-<sanitised-recordingId>-<unique-suffix>`.
 *   - `eam-` namespace so the finalizer can ignore jobs it didn't
 *     start (defence-in-depth — the EventBridge rule already scopes
 *     to our jobs, but a shared account could surface foreign jobs).
 *   - `<sanitised-recordingId>` — recordingIds are UUIDs (only
 *     `[0-9a-f-]`), already job-name-safe; we still run a
 *     sanitiser so a non-UUID id (legacy / test) can't produce an
 *     invalid job name. Disallowed chars collapse to `_`.
 *   - `<unique-suffix>` — millisecond timestamp + short random, so a
 *     re-run on the same recording (admin "rerun on backend X") does
 *     not collide with the still-resolving prior job name. The
 *     finalizer strips it back off via the `eam-<id>-` prefix.
 *
 * Pure JS. No AWS imports — both the backend handler and the
 * finalizer import this so the encode + decode stay in lockstep.
 */

export const JOB_NAME_PREFIX = 'eam-';

/** Amazon Transcribe's hard cap on a transcription job name. */
export const JOB_NAME_MAX_LENGTH = 200;

/** Chars Transcribe forbids in a job name collapse to `_`. */
function sanitiseRecordingId(recordingId: string): string {
  return recordingId.replace(/[^0-9a-zA-Z._-]/g, '_');
}

export interface BuildJobNameOpts {
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable randomness for deterministic tests. Defaults to `Math.random`. */
  rand?: () => number;
}

/**
 * Builds a unique Transcribe job name that embeds `recordingId`.
 * The recordingId is sanitised; the trailing `-<ts>-<rand>` keeps
 * re-runs from colliding. Throws on an empty recordingId so a bad
 * dispatch message fails loud rather than producing `eam--<...>`
 * which the decoder would map back to an empty id.
 */
export function buildJobName(recordingId: string, opts: BuildJobNameOpts = {}): string {
  if (typeof recordingId !== 'string' || recordingId.trim() === '') {
    throw new Error('buildJobName: recordingId is required');
  }
  const safe = sanitiseRecordingId(recordingId);
  const now = opts.now ?? Date.now;
  const rand = opts.rand ?? Math.random;
  const suffix = `${now()}-${Math.floor(rand() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;
  const name = `${JOB_NAME_PREFIX}${safe}-${suffix}`;
  // Transcribe caps job names at 200 chars. A UUID recordingId
  // (36 chars) + `eam-` + suffix is ~60 chars — nowhere near the cap.
  // We must NOT silently `slice(0, 200)`: that would chop the trailing
  // `-<ts>-<rand>` suffix, leaving `recordingIdFromJobName` unable to
  // strip the (now-missing) suffix and so decoding the wrong/partial
  // id. For a pathologically long id we fail loudly instead — the
  // caller's retry/DLQ path surfaces it rather than the finalizer
  // silently mis-attributing a transcript. Real recordingIds never
  // trip this.
  if (name.length > JOB_NAME_MAX_LENGTH) {
    throw new Error(
      `buildJobName: encoded job name (${name.length} chars) exceeds Transcribe's ${JOB_NAME_MAX_LENGTH}-char limit for recordingId of length ${recordingId.length}`,
    );
  }
  return name;
}

/**
 * Recovers the recordingId embedded in a job name produced by
 * `buildJobName`. Returns `null` for any name that doesn't match
 * the `eam-<id>-<ts>-<rand>` shape (foreign job, malformed name) so
 * the finalizer can no-op instead of throwing into EventBridge's
 * infinite-retry path.
 */
export function recordingIdFromJobName(jobName: string | null | undefined): string | null {
  if (typeof jobName !== 'string' || !jobName.startsWith(JOB_NAME_PREFIX)) {
    return null;
  }
  const withoutPrefix = jobName.slice(JOB_NAME_PREFIX.length);
  // Strip the trailing `-<ts>-<rand>` suffix (two trailing
  // `-`-delimited fields). Everything before is the sanitised
  // recordingId, which may itself contain `-` (UUIDs do).
  const lastDash = withoutPrefix.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const secondLastDash = withoutPrefix.lastIndexOf('-', lastDash - 1);
  if (secondLastDash <= 0) return null;
  const id = withoutPrefix.slice(0, secondLastDash);
  return id.length > 0 ? id : null;
}
