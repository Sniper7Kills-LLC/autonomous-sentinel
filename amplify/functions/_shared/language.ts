/**
 * English-only language hint + non-English handling (#60).
 *
 * Every transcribe backend (#54-#57) hard-sets `language=en` (or
 * the backend equivalent) at invocation time per CLAUDE.md →
 * Pipeline components → Transcribe Lambda ("language hint = en;
 * reject non-English but still attempt"). The detected-language
 * field on the backend response then decides whether the
 * Recording flows into Linguistic Logic (#62) or is held for
 * admin review.
 *
 * Pure JS. The deferred backend post-processing step calls
 * `evaluateLanguage(detection, config)` and:
 *   - On `{ accepted: true, flagged: false }`: pipeline proceeds
 *     normally; Linguistic Logic runs.
 *   - On `{ accepted: false, flagged: true }`: Recording row gets
 *     `detectedLanguage` + `flaggedLanguageMismatch=true`; the
 *     dispatcher to Linguistic Logic skips this Recording until
 *     an admin reviews.
 *   - On `{ accepted: true, flagged: false, reason: ... }` when
 *     the detection is non-English BUT low confidence: tolerated
 *     as noise, pipeline proceeds. CLAUDE.md prefers an over-
 *     attempt over a silent drop on borderline detections.
 *
 * Defensive: missing / null / unknown language codes are treated
 * as "no evidence either way" — Recording flows through. A bad
 * detection field can't silently park every Recording in the
 * review queue.
 */

export const EXPECTED_LANGUAGE = 'en';
export const DEFAULT_MISMATCH_CONFIDENCE_THRESHOLD = 0.6;

export interface LanguageDetection {
  /**
   * Detected language code as the backend reports it. Whisper
   * sometimes reports `"english"` (lib varies); Amazon Transcribe
   * reports `"en-US"`; we normalise both to the IETF subtag.
   */
  language?: string | null;
  /**
   * Backend-reported confidence in `[0, 1]`. Whisper hosted +
   * Amazon Transcribe surface this; whisper.cpp + Bedrock often
   * do not — caller passes `undefined` in that case and the
   * helper treats it as a high-confidence detection (so the
   * mismatch flag still fires on a definitive non-English).
   */
  confidence?: number | null;
}

export interface LanguageEvaluation {
  /**
   * Whether the dispatcher should hand off to Linguistic Logic.
   * `false` means the Recording is held for admin review.
   */
  accepted: boolean;
  /**
   * Whether to set `Recording.flaggedLanguageMismatch=true`.
   * Implies `accepted=false`; the two are kept distinct so a
   * future "soft flag without holding the pipeline" mode is a
   * one-line change.
   */
  flagged: boolean;
  /**
   * Normalised IETF subtag (`'en'`, `'de'`, `'es'`, ...) ready to
   * write into `Recording.detectedLanguage`. `null` when the
   * caller passed no detection.
   */
  normalisedCode: string | null;
  /** Human-readable reason for CloudWatch + admin-queue display. */
  reason: string;
}

export interface LanguageEvaluationOpts {
  /**
   * Override the expected language. Defaults to `'en'` per
   * CLAUDE.md.
   */
  expectedLanguage?: string;
  /**
   * Override the mismatch confidence threshold. Defaults to
   * `0.6` per the #60 spec.
   */
  mismatchConfidenceThreshold?: number;
}

/**
 * Normalises a backend-reported language string to the IETF
 * subtag. Strips region (`en-US` → `en`), lowercases, maps the
 * common Whisper alias `"english"` to `"en"` (same for a handful
 * of other languages we see in the wild — keep this list minimal,
 * Whisper's full name → code mapping is large and we only care
 * about the ones we've actually observed).
 *
 * Returns `null` on empty / non-string input so the caller's
 * downstream comparison can short-circuit on "no detection".
 */
export function normalizeLanguageCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toLowerCase();
  if (trimmed === '') return null;
  const region = trimmed.split(/[-_]/)[0] ?? trimmed;
  return LANGUAGE_NAME_ALIASES[region] ?? region;
}

/**
 * Subset of Whisper's spoken-name → code mapping for the
 * languages we've actually seen in HF voice traffic. Extend
 * conservatively when a new backend ships and we observe a new
 * alias in production.
 */
const LANGUAGE_NAME_ALIASES: Record<string, string> = {
  english: 'en',
  eng: 'en',
  german: 'de',
  spanish: 'es',
  french: 'fr',
  russian: 'ru',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  arabic: 'ar',
};

/**
 * Decides whether a Recording proceeds into Linguistic Logic or
 * is held for admin review based on the detected language +
 * confidence.
 */
export function evaluateLanguage(
  detection: LanguageDetection | null | undefined,
  opts: LanguageEvaluationOpts = {},
): LanguageEvaluation {
  const expected = (opts.expectedLanguage ?? EXPECTED_LANGUAGE).toLowerCase();
  const threshold = opts.mismatchConfidenceThreshold ?? DEFAULT_MISMATCH_CONFIDENCE_THRESHOLD;

  const rawCode = detection?.language ?? null;
  const normalisedCode = normalizeLanguageCode(rawCode);

  if (normalisedCode === null) {
    return {
      accepted: true,
      flagged: false,
      normalisedCode: null,
      reason: 'no-detection',
    };
  }

  if (normalisedCode === expected) {
    return {
      accepted: true,
      flagged: false,
      normalisedCode,
      reason: `expected-language-${expected}`,
    };
  }

  const confidence = detection?.confidence;
  const isHighConfidence =
    typeof confidence !== 'number' || // missing confidence treated as definitive
    !Number.isFinite(confidence) ||
    confidence > threshold;

  if (!isHighConfidence) {
    return {
      accepted: true,
      flagged: false,
      normalisedCode,
      reason: `low-confidence-${normalisedCode}-tolerated`,
    };
  }

  return {
    accepted: false,
    flagged: true,
    normalisedCode,
    reason: `non-${expected}-${normalisedCode}`,
  };
}
