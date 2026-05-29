/**
 * Pure stream-record parser for the LinguisticConfig DynamoDB stream
 * (#481).
 *
 * The handler unmarshals each `dynamodb.OldImage` / `NewImage`
 * AttributeValue map into a plain object, then hands it here. Keeping
 * the decision logic pure (no AWS SDK, no I/O) makes the two behaviours
 * the issue asks for — audit-on-update and reprocess-on-bump — unit
 * testable against in-memory fixtures.
 */

/**
 * Keys that carry a Linguistic Logic prompt version. Bumping one of
 * these is the signal to reprocess previously-failed Recordings
 * (CLAUDE.md → Linguistic Logic). Matches e.g. `SKYKING_PROMPT_VERSION`,
 * `ALLSTATIONS_PROMPT_VERSION`.
 */
export const PROMPT_VERSION_KEY_RE = /_PROMPT_VERSION$/;

/** Plain (unmarshalled) snapshot of a LinguisticConfig row. */
export interface LinguisticConfigImage {
  key?: string | null;
  value?: unknown;
  promptVersion?: number | null;
  activeAt?: string | null;
  createdById?: string | null;
  notes?: string | null;
}

export interface StreamRecordInput {
  eventName?: string;
  oldImage?: LinguisticConfigImage | null;
  newImage?: LinguisticConfigImage | null;
}

export interface ParsedConfigChange {
  /** The config key — the audit target id. */
  key: string;
  /**
   * Actor for the audit row. The stream has no AppSync identity, so we
   * attribute the change to the row's `createdById` (the admin who owns
   * the record), falling back to `null` (system) when absent.
   */
  actorId: string | null;
  /** Snapshot before the change ({} for INSERT). */
  before: Record<string, unknown>;
  /** Snapshot after the change ({} for REMOVE). */
  after: Record<string, unknown>;
  /** Every stream record is an auditable config change. */
  isUpdate: boolean;
  /** True only when a `*_PROMPT_VERSION` key's version increased. */
  isPromptVersionBump: boolean;
  /** The new version number on a bump; `null` otherwise. */
  newPromptVersion: number | null;
}

/** Fields included in the audit before/after diff. `createdById` is the
 * actor, not diffed content, so it is excluded from the snapshots. */
function snapshot(image: LinguisticConfigImage | null | undefined): Record<string, unknown> {
  if (!image) return {};
  const out: Record<string, unknown> = {};
  if (image.key !== undefined) out.key = image.key;
  if (image.value !== undefined) out.value = image.value;
  if (image.promptVersion !== undefined) out.promptVersion = image.promptVersion;
  if (image.activeAt !== undefined) out.activeAt = image.activeAt;
  if (image.notes !== undefined) out.notes = image.notes;
  return out;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parse one LinguisticConfig stream record into the audit + reprocess
 * decision. Returns `null` when the record carries no key on either
 * image (an audit entry without a target is meaningless — see
 * `audit-log-helper.ts`).
 */
export function parseConfigStreamRecord(rec: StreamRecordInput): ParsedConfigChange | null {
  const key = rec.newImage?.key ?? rec.oldImage?.key;
  if (!key) return null;

  const isRemove = rec.eventName === 'REMOVE';
  const actorId = rec.newImage?.createdById ?? rec.oldImage?.createdById ?? null;

  let isPromptVersionBump = false;
  let newPromptVersion: number | null = null;

  // A bump only happens on a live write (not a delete) to a prompt-
  // version key whose numeric version increased over the prior value.
  if (!isRemove && PROMPT_VERSION_KEY_RE.test(key)) {
    const next = rec.newImage?.promptVersion;
    if (isFiniteNumber(next)) {
      const prev = rec.oldImage?.promptVersion;
      const prevVersion = isFiniteNumber(prev) ? prev : Number.NEGATIVE_INFINITY;
      if (next > prevVersion) {
        isPromptVersionBump = true;
        newPromptVersion = next;
      }
    }
  }

  return {
    key,
    actorId,
    before: snapshot(rec.oldImage),
    after: snapshot(rec.newImage),
    isUpdate: true,
    isPromptVersionBump,
    newPromptVersion,
  };
}
