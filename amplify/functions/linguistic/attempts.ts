import { createHash } from 'node:crypto';

/**
 * Linguistic Logic per-recording attempt log helpers (#64).
 *
 * Every Linguistic Logic invocation — rules path (#62) or AI
 * fallback (#63) — appends a `LinguisticAttempt` onto the
 * Recording's `linguisticAttempts` JSON column. Before invoking,
 * the Lambda checks the existing array: if a successful attempt
 * with the same `(provider, promptVersion, promptHash)` exists,
 * the Lambda reuses that prior result instead of paying the
 * Bedrock cost again. That is what makes "same (provider +
 * prompt_version) never re-runs on the same input" (CLAUDE.md)
 * idempotent, and is the substrate #66 (reprocess-only-failed)
 * builds on.
 *
 * Pure JS — no DDB I/O. The caller loads the Recording, passes
 * the existing `linguisticAttempts` to `shouldSkip` /
 * `lastSuccessfulResult`, and on a fresh run calls `appendAttempt`
 * + persists the new array back via the regular Recording update
 * mutation.
 *
 * Hashing is deterministic SHA-256 over the rendered prompt
 * (template + transcript substitution). Hex digest, lowercase.
 */

export type LinguisticProvider = 'rules' | 'bedrock';

export interface LinguisticAttempt {
  /** Which engine produced the attempt. */
  provider: LinguisticProvider;
  /**
   * Prompt version recorded for the attempt. For the rules path
   * (#62) this is the matched rule's `promptVersion`; for the
   * Bedrock path (#63) this is the LinguisticPromptTemplate
   * version. Stored as `null` only on rules-path attempts where
   * no rule matched (so a future re-run on a new rule set isn't
   * incorrectly skipped).
   */
  promptVersion: number | null;
  /**
   * SHA-256 hex digest of the rendered prompt for the Bedrock
   * path. `null` for the rules path (no prompt) and for failed
   * pre-prompt invocations.
   */
  promptHash: string | null;
  /**
   * SHA-256 hex digest of the parsed-Message result on success,
   * `null` on failure. The hash gives us a cheap content-equality
   * check for #66's "did the new prompt actually change anything"
   * audit query without storing the whole parsed payload twice.
   */
  resultHash: string | null;
  /** True when the attempt produced a Message; false on parse failure. */
  success: boolean;
  /** UTC ISO 8601 timestamp of the attempt. */
  ts: string;
}

/**
 * Deterministic SHA-256 hex digest of the rendered prompt. Used
 * both for `LinguisticAttempt.promptHash` and as the
 * change-detection signal when a prompt template is edited
 * (different body → different hash → not skipped).
 */
export function hashPrompt(rendered: string): string {
  return createHash('sha256').update(rendered, 'utf8').digest('hex');
}

/**
 * Deterministic SHA-256 hex digest of the parsed-Message result.
 * Caller is responsible for canonical JSON ordering (sorted keys)
 * before passing in — this helper is a thin SHA-256 wrapper so
 * tests can pin the same hash whether the result was serialised
 * inline or by the consumer Lambda.
 */
export function hashResult(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

interface SkipKey {
  provider: LinguisticProvider;
  promptVersion: number | null;
  promptHash: string | null;
}

/**
 * Returns true when the attempt log already contains a successful
 * attempt with the same `(provider, promptVersion, promptHash)`
 * triple. Caller short-circuits the Bedrock call and reuses the
 * prior result on `true`.
 *
 * Failed attempts (`success=false`) NEVER short-circuit — the
 * caller retries on the next invocation regardless. That is what
 * makes #66's "reprocess only failed recordings on prompt-version
 * bump" cheap: bump the version, the new `(provider, version,
 * hash)` triple has no prior attempt, so all previously-failed
 * recordings re-run.
 */
export function shouldSkip(
  attempts: LinguisticAttempt[] | null | undefined,
  key: SkipKey,
): boolean {
  if (!Array.isArray(attempts) || attempts.length === 0) return false;
  return attempts.some(
    (a) =>
      a.success === true &&
      a.provider === key.provider &&
      a.promptVersion === key.promptVersion &&
      a.promptHash === key.promptHash,
  );
}

/**
 * Returns the most-recent successful attempt matching the
 * `(provider, promptVersion, promptHash)` triple, or `undefined`
 * when none exists. Used by the consumer to reconstruct the
 * `resultHash` it should reuse on the short-circuit path.
 */
export function lastSuccessfulResult(
  attempts: LinguisticAttempt[] | null | undefined,
  key: SkipKey,
): LinguisticAttempt | undefined {
  if (!Array.isArray(attempts) || attempts.length === 0) return undefined;
  // Iterate in reverse for most-recent-first; tie-break by ts ISO
  // string lex compare (ISO 8601 sorts lex == chronological).
  let best: LinguisticAttempt | undefined;
  for (const a of attempts) {
    if (
      a.success !== true ||
      a.provider !== key.provider ||
      a.promptVersion !== key.promptVersion ||
      a.promptHash !== key.promptHash
    ) {
      continue;
    }
    if (!best || a.ts > best.ts) best = a;
  }
  return best;
}

export interface AppendOpts {
  /** Wall-clock source. Defaults to `Date.now`. Tests override. */
  now?: () => Date;
}

/**
 * Returns a NEW array with `next` appended. Pure — does not
 * mutate the input. Caller persists the returned array via the
 * Recording update mutation.
 *
 * `now` override lets tests pin the `ts` timestamp without
 * faking the system clock.
 */
export function appendAttempt(
  attempts: LinguisticAttempt[] | null | undefined,
  next: Omit<LinguisticAttempt, 'ts'> & { ts?: string },
  opts: AppendOpts = {},
): LinguisticAttempt[] {
  const ts = next.ts ?? (opts.now ?? (() => new Date()))().toISOString();
  const attempt: LinguisticAttempt = {
    provider: next.provider,
    promptVersion: next.promptVersion,
    promptHash: next.promptHash,
    resultHash: next.resultHash,
    success: next.success,
    ts,
  };
  const base = Array.isArray(attempts) ? attempts : [];
  return [...base, attempt];
}
