import { a } from '@aws-amplify/backend';

/**
 * LinguisticPromptTemplate — admin-managed prompt templates for the
 * Linguistic Logic Lambda's Bedrock AI fallback (#64).
 *
 * Each row is a versioned snapshot of the prompt body sent to
 * Bedrock. The Lambda resolves the active version (`isActive=true`)
 * for a given `promptId` at invocation time, renders it against the
 * transcript, hashes the rendered text (`sha256`), and appends a
 * `LinguisticAttempt` record onto the Recording's
 * `linguisticAttempts` JSON column. Subsequent invocations with
 * the same `(provider, promptVersion, promptHash)` short-circuit
 * the Bedrock call — the substrate that makes "bumping prompt-
 * version re-runs parsing only on previously-failed recordings"
 * (#66) cheap.
 *
 * Activation semantics:
 *   - Only one row per `promptId` should have `isActive=true` at
 *     any given moment. Atomicity is enforced by the admin
 *     activation mutation (deferred; same pattern as #62/#63 —
 *     model lands here, GraphQL admin mutation lands separately).
 *   - The Lambda treats a multi-active state as a bug: the
 *     first-by-version-desc wins; CloudWatch warn logged.
 *
 * Invariants enforced by the deferred admin mutation (NOT the
 * Amplify Gen 2 model layer, which has no composite-uniqueness
 * or string-content validation primitives):
 *   - `(promptId, version)` uniqueness — the create mutation reads
 *     the current max version for the promptId via a GSI Query and
 *     writes `max + 1` under a conditional `attribute_not_exists`
 *     guard on the synthesised composite key. Concurrent admin
 *     creates lose the race and retry with the new max.
 *   - `body` contains `{{TRANSCRIPT}}` — the create + update
 *     mutations reject any body string that fails the placeholder
 *     check before the row lands. The Lambda render step assumes
 *     the placeholder is present (matches the `ai-fallback.ts`
 *     #63 contract — that helper throws on missing placeholder, so
 *     the mutation MUST catch it at write time, not parse time).
 *   - Exactly one `isActive=true` row per `promptId` — atomic
 *     activation mutation flips the prior active row to `false` +
 *     the new row to `true` inside a TransactWriteItems.
 *
 * Authz:
 *   - admin group: full CRUD (only mutators).
 *   - linguistic Lambda: schema-level `allow.resource(...)` grant
 *     in `amplify/data/resource.ts` when the consumer wiring
 *     ships.
 *
 * Deferred:
 *   - Atomic activation mutation (one-of-N is-active flip).
 *   - Admin UI for editing prompt bodies (later phase).
 */
export const LinguisticPromptTemplate = a
  .model({
    /**
     * Logical prompt identifier — e.g. `linguistic-parse-bedrock`.
     * Multiple versions of the same `promptId` accumulate over
     * time; only one is active.
     */
    promptId: a.string().required(),
    /**
     * Monotonically-increasing version per `promptId`. The Lambda
     * records this into `linguisticAttempts.promptVersion` so the
     * skip-check is exact.
     */
    version: a.integer().required(),
    /**
     * Prompt body. MUST contain `{{TRANSCRIPT}}` — the Lambda
     * substitutes the transcript text at render time. Same
     * convention as `ai-fallback.ts` (#63).
     */
    body: a.string().required(),
    /**
     * Cognito sub of the admin who created this row. Audit trail
     * marker; never used as authorization.
     */
    createdBy: a.string(),
    /**
     * Exactly one row per `promptId` carries `isActive=true`.
     * The Lambda fetches by `(promptId, isActive=true)` to resolve
     * the version to run.
     */
    isActive: a.boolean().default(false),
    /**
     * Free-form admin notes — why this version was created, what
     * changed vs the prior version.
     */
    notes: a.string(),
  })
  // No GSI. Prompt count is bounded (a handful of promptIds, dozens
  // of versions each), so the Lambda's resolve-active query Scans
  // + filters in-memory. Cheaper than maintaining a sparse GSI on
  // `(promptId, isActive)` for a table this small.
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);
