/**
 * Linguistic Logic confidence-threshold gate (#65).
 *
 * Decides whether a parsed Message lands clean or flagged for
 * community review. Per CLAUDE.md → Pipeline components →
 * Linguistic Logic + → DynamoDB → Message:
 *
 *   "confidence ≥ 0.8 → auto-published clean
 *    confidence < 0.8 → auto-published, flagged for community review"
 *
 * Threshold is admin-tunable per message type (CLAUDE.md:
 * "Confidence threshold: 0.8 default, admin-tunable per message
 * type"). The rules engine produces near-1.0 confidence on well-
 * formed SKYKING / RADIOCHECK but lower on freeform OTHER traffic,
 * so a single global value loses signal.
 *
 * Resolution order, first hit wins:
 *   1. `config.confidenceThresholds[message.type]` — per-type
 *      override.
 *   2. `config.confidenceThresholds.DEFAULT` — global override.
 *   3. `DEFAULT_CONFIDENCE_THRESHOLD` (0.8) — hard-coded fallback
 *      so a fresh sandbox with no LinguisticConfig row still
 *      gates correctly.
 *
 * Pure JS — no DDB I/O. Caller loads the LinguisticConfig
 * `CONFIDENCE_THRESHOLDS` row, parses the `value` JSON into a
 * `ConfidenceConfig`, and passes it in. On a config-row-missing
 * path the caller passes an empty `{ confidenceThresholds: {} }`
 * and the helper falls through to the hard-coded default.
 *
 * Boundary: `confidence === threshold` is CLEAN (matches the
 * CLAUDE.md `≥` wording).
 */

/** Hard-coded fallback when neither per-type nor DEFAULT is configured. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

export interface ConfidenceConfig {
  /**
   * Map of message-type → threshold in `[0, 1]`. `DEFAULT` is the
   * special key consulted when the message's type has no explicit
   * entry.
   */
  confidenceThresholds: Record<string, number>;
}

export interface ParsedForThreshold {
  /** Message type from the CLAUDE.md domain enum. */
  type: string;
  /** Model / rule-reported confidence in `[0, 1]`. */
  confidence: number;
}

/**
 * Returns the active threshold for the given message type.
 * Resolution order: per-type → DEFAULT → hard-coded 0.8.
 *
 * Treats NaN / out-of-range entries as missing so a corrupted
 * admin-edited row can't silently relax the gate to 0 or push it
 * to 2 (effectively flagging every Message). The corruption
 * surfaces via CloudWatch warn but the safe default still applies.
 */
export function resolveThreshold(type: string, config: ConfidenceConfig): number {
  const map = config.confidenceThresholds ?? {};
  const perType = map[type];
  if (isValidThresholdValue(perType)) return perType;
  if (perType !== undefined) {
    console.warn('threshold: ignoring out-of-range per-type threshold', {
      type,
      value: perType,
    });
  }
  const fallback = map.DEFAULT;
  if (isValidThresholdValue(fallback)) return fallback;
  if (fallback !== undefined) {
    console.warn('threshold: ignoring out-of-range DEFAULT threshold', {
      value: fallback,
    });
  }
  return DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * Returns true when `parsed.confidence < threshold` so the
 * Message should land with `flaggedForReview=true`. Boundary
 * (`confidence === threshold`) lands CLEAN per CLAUDE.md's `≥`
 * wording.
 */
export function isFlagged(parsed: ParsedForThreshold, config: ConfidenceConfig): boolean {
  if (typeof parsed.confidence !== 'number' || Number.isNaN(parsed.confidence)) {
    // Defensive: a non-numeric confidence shouldn't reach this
    // helper (the Bedrock fallback + rules engine both produce a
    // number), but if it does we treat it as low-signal and flag
    // rather than auto-clean.
    return true;
  }
  const threshold = resolveThreshold(parsed.type, config);
  return parsed.confidence < threshold;
}

/**
 * Used by the deferred admin mutation `setConfidenceThreshold`
 * to reject out-of-range writes before they hit DDB. Same
 * validation lives in the model docstring as a contract requirement
 * since Amplify Gen 2's DSL has no numeric-range validator.
 */
export function isValidThresholdValue(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (Number.isNaN(value)) return false;
  if (value < 0 || value > 1) return false;
  return true;
}
