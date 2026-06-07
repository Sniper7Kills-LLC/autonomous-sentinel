import { a } from '@aws-amplify/backend';

/**
 * LinguisticTrace — per-run deep-debug capture of the Linguistic Logic
 * pipeline (#744).
 *
 * The pipeline already records hash-only summaries on
 * `Recording.linguisticAttempts` (#64). That is enough for the
 * reprocess-on-bump gate but useless for debugging WHY a transcript parsed
 * the way it did. This model captures the full per-run detail a debugger
 * wants — which regex rules ran and what each matched, the exact Bedrock
 * prompt sent, and the raw Converse response — so the diagnostics surface
 * (#745) can render it and diff re-runs.
 *
 * One row per linguistic run, keyed by recording + `runAt` so the per-run
 * history is naturally ordered and diffable. Written best-effort by the
 * linguistic Lambda after the authoritative Recording update — a trace
 * write must never sink the pipeline or the 30-minute SLA.
 *
 * Cost control:
 *   - DynamoDB TTL on `ttl` (epoch seconds; default 90 days) expires old
 *     traces automatically. Configured via a CfnTable override in
 *     `backend.ts` (the Gen 2 DSL has no TTL primitive).
 *   - Size guard: when the serialized row would exceed the DDB item limit
 *     the linguistic Lambda truncates the two large text fields
 *     (`bedrockRenderedPrompt`, `bedrockRawResponse`) and sets
 *     `truncated=true`. The S3 SPILL — moving those fields to a
 *     `diagnostics/` object keyed in `overflowKeys` — is supported by the
 *     size-guard helper but NOT wired at v1: granting the data-stack
 *     linguistic Lambda an S3 bucket-token reference is a known CFN-cycle
 *     trigger (#644), so it is a #744 follow-up. Until then oversized rows
 *     drop the prompt/response blob but keep every structured field.
 *
 * Authz: read for admin + moderator + diagnostics (the diagnostics group
 * is the additive capability group from #743); writes come only from the
 * linguistic Lambda via the schema-level `allow.resource(linguistic)`
 * grant in `amplify/data/resource.ts`. No guest/public read.
 */
export const LinguisticTrace = a
  .model({
    /** Recording this run parsed. Indexed for per-recording trace history. */
    recordingId: a.id().required(),
    /** UTC ISO 8601 timestamp of the run (sort key within a recording). */
    runAt: a.datetime().required(),
    /** Which transcript backend triggered this run (whisper-local, …). */
    triggerBackend: a.string(),
    /** The transcript text parsed this run — keeps the trace self-contained. */
    transcriptSnapshot: a.string(),

    /**
     * Every rule the engine evaluated this run (JSON array of
     * `{ ruleId, component, messageType, pattern, matched, matchedText,
     * captures, confidence }`). Shows which regexes ran + what each
     * matched, not just the winner.
     */
    rulesEvaluated: a.json(),
    /**
     * The winning rules-engine result (JSON `{ ruleId, messageType, fields,
     * confidence }`) or null when no rule matched and the run fell to AI.
     */
    rulesOutcome: a.json(),

    /** Whether the Bedrock AI fallback ran this run. */
    bedrockInvoked: a.boolean(),
    bedrockModelId: a.string(),
    bedrockPromptVersion: a.integer(),
    bedrockPromptHash: a.string(),
    /** Full rendered prompt (template + transcript + reconcile + context). */
    bedrockRenderedPrompt: a.string(),
    /** Complete raw Converse response object (JSON). */
    bedrockRawResponse: a.json(),
    /** Extracted parse (JSON `{ type, sender, receiver, body, confidence, retried }`). */
    bedrockParsed: a.json(),
    /** Per-component rules the model proposed this run (JSON array). */
    bedrockProposedRules: a.json(),

    /** Final parse the Message was created from (JSON `{ type, sender, receiver, body, confidence, source }`). */
    finalResult: a.json(),
    /** Whether the run produced a successful parse (mirrors the attempt log). */
    attemptSuccess: a.boolean(),
    /** SHA-256 of the canonical parse result — correlates to linguisticAttempts. */
    resultHash: a.string(),
    /** SHA-256 of the rendered prompt — correlates to linguisticAttempts. */
    promptHash: a.string(),

    /**
     * S3 keys for fields spilled out of the row when it exceeded the DDB
     * item limit (JSON `{ renderedPrompt?, rawResponse? }`). The
     * diagnostics UI signed-URL-fetches these on demand.
     */
    overflowKeys: a.json(),
    /** True when one or more large fields were spilled to S3. */
    truncated: a.boolean(),

    /** DynamoDB TTL attribute (epoch seconds). Set ~90 days out at write. */
    ttl: a.integer(),
  })
  .secondaryIndexes((i) => [i('recordingId').sortKeys(['runAt'])])
  .authorization((allow) => [allow.groups(['admin', 'moderator', 'diagnostics']).to(['read'])]);
