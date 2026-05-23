/**
 * Lambda reserved-concurrency cap helpers (#68).
 *
 * Per CLAUDE.md → Stack table → Budgets, a runaway pipeline stage
 * (a contest-day burst of SDR uploads, a stuck retry loop, etc.)
 * can drain the AWS budget inside hours if uncapped. Reserved
 * concurrency on each consumer Lambda bounds the worst-case
 * blast radius without breaking the happy path.
 *
 * Per CLAUDE.md → Whisper container Lambda: "tolerate cold start,
 * no provisioned concurrency" — caps here are RESERVED
 * (`reservedConcurrentExecutions`), never provisioned.
 *
 * This module is the pure-JS slice (env lookup + validation +
 * default table). Application to specific Lambda resources lives
 * in `amplify/backend.ts` via the `CfnFunction` L1 escape-hatch.
 *
 * Defaults (CONCURRENCY_* env vars override):
 *   - preprocess (#49-#52)              20 — cheap; parallel-safe
 *   - transcribe-dispatch (#58)         20 — just routes
 *   - transcribe-whisper-local (#54)    5  — container Lambda; cold-start memory
 *   - transcribe-openai (#55)           3  — hosted API cost is real
 *   - transcribe-amazon (#56)           10 — AWS-internal
 *   - transcribe-bedrock (#57)          5  — per-token cost varies
 *   - linguistic (#62-#65)              10 — cheap unless AI fallback hits
 *   - linguistic-reprocess (#66)        2  — backfill must NOT starve live
 *
 * The 2-cap on `linguistic-reprocess` is the load-bearing one:
 * when an admin bumps the prompt version, reprocess fans out
 * across hundreds of failed Recordings, and we don't want that
 * batch starving live traffic.
 */

/**
 * Logical Lambda keys that map to `CONCURRENCY_<KEY>` env vars.
 * Add a new key when a new consumer Lambda lands.
 */
export const CONCURRENCY_KEYS = [
  'PREPROCESS',
  'TRANSCRIBE_DISPATCH',
  'TRANSCRIBE_WHISPER_LOCAL',
  'TRANSCRIBE_OPENAI',
  'TRANSCRIBE_AMAZON',
  'TRANSCRIBE_BEDROCK',
  'LINGUISTIC',
  'LINGUISTIC_REPROCESS',
] as const;

export type ConcurrencyKey = (typeof CONCURRENCY_KEYS)[number];

export const DEFAULT_CONCURRENCY: Record<ConcurrencyKey, number> = {
  PREPROCESS: 20,
  TRANSCRIBE_DISPATCH: 20,
  TRANSCRIBE_WHISPER_LOCAL: 5,
  TRANSCRIBE_OPENAI: 3,
  TRANSCRIBE_AMAZON: 10,
  TRANSCRIBE_BEDROCK: 5,
  LINGUISTIC: 10,
  LINGUISTIC_REPROCESS: 2,
};

/**
 * AWS Lambda's account-level concurrency soft limit is 1000.
 * Capping at 500 here leaves headroom for unrelated consumers
 * (auth triggers, GraphQL resolvers) and surfaces typo'd big
 * numbers (`CONCURRENCY_OPENAI=300` instead of `30`) as an
 * explicit throw rather than a silent quota-exhaustion outage.
 */
export const MAX_RESERVED_CONCURRENCY = 500;

export interface ConcurrencyOpts {
  /** Env source. Defaults to `process.env`. Tests inject in-memory. */
  env?: Record<string, string | undefined>;
}

/**
 * Returns the active reserved-concurrency cap for the given
 * logical key. Resolution: env override → built-in default.
 * Invalid env values (non-integer, ≤ 0, > `MAX_RESERVED_CONCURRENCY`)
 * fall back to the default with a CloudWatch warn so a fat-finger
 * in admin tuning can't silently break the cap.
 */
export function getConcurrencyCap(key: ConcurrencyKey, opts: ConcurrencyOpts = {}): number {
  const env = opts.env ?? process.env;
  const raw = env[`CONCURRENCY_${key}`];
  const fallback = DEFAULT_CONCURRENCY[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  // Strict decimal-only check before parseInt — `Number('0xFF')`
  // and `parseInt('10abc', 10)` are both too lenient and could
  // mask a typo'd env var (`0xFF`, `10abc`) as a valid cap.
  // Admin tuning ought to be unambiguous decimal.
  if (!/^[1-9]\d{0,3}$/.test(raw)) {
    console.warn('lambda-concurrency: ignoring invalid CONCURRENCY_* env var', {
      key,
      raw,
      fallback,
    });
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (parsed <= 0 || parsed > MAX_RESERVED_CONCURRENCY) {
    console.warn('lambda-concurrency: ignoring out-of-range CONCURRENCY_* env var', {
      key,
      raw,
      fallback,
    });
    return fallback;
  }
  return parsed;
}

/**
 * Returns the entire env-resolved cap map. Convenience for
 * `backend.ts` to apply all caps in one pass.
 */
export function readConcurrencyConfig(opts: ConcurrencyOpts = {}): Record<ConcurrencyKey, number> {
  const out = { ...DEFAULT_CONCURRENCY };
  for (const key of CONCURRENCY_KEYS) {
    out[key] = getConcurrencyCap(key, opts);
  }
  return out;
}
