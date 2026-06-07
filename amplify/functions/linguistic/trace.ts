/**
 * LinguisticTrace assembly + size-guard + persist (#744).
 *
 * Turns a linguistic run's diagnostic data (rule evaluations, Bedrock
 * request/response, final parse) into a `LinguisticTrace` row, spills the
 * two large text fields to S3 when the row would exceed the DynamoDB item
 * limit, and writes it best-effort. A trace write must NEVER sink the
 * pipeline, so `persistTrace` swallows every error.
 *
 * `a.json()` columns are persisted as stringified JSON (matching how the
 * handler already writes `linguisticAttempts` / `transcripts`).
 */

/** Default trace retention before the DynamoDB TTL expires the row. */
export const TRACE_TTL_DAYS_DEFAULT = 90;
/**
 * Spill the large text fields to S3 when the serialized row exceeds this.
 * Well under the 400 KB DDB item limit, leaving headroom for the rest of
 * the row + AppSync envelope.
 */
export const MAX_INLINE_TRACE_BYTES = 350_000;

const SECONDS_PER_DAY = 86_400;

/** Bedrock half of a trace; null when the AI fallback did not run. */
export interface TraceBedrock {
  modelId: string;
  promptVersion: number;
  promptHash: string | null;
  renderedPrompt: string;
  /** Raw Converse response (or null when Bedrock returned nothing usable). */
  rawResponse: unknown;
  /** Extracted parse `{ type, sender, receiver, body, confidence, retried }`. */
  parsed: unknown;
  /** Sanitized per-component rules the model proposed. */
  proposedRules: unknown;
}

export interface TraceInput {
  recordingId: string;
  /** UTC ISO 8601 timestamp of the run (sort key within the recording). */
  runAt: string;
  triggerBackend: string;
  transcriptSnapshot: string;
  /** RuleEvaluation[] from the engine's traced match. */
  rulesEvaluated: unknown;
  /** Winning RuleMatch, or null when no rule matched. */
  rulesOutcome: unknown;
  bedrock: TraceBedrock | null;
  /** `{ type, sender, receiver, body, confidence, source }`. */
  finalResult: unknown;
  attemptSuccess: boolean;
  resultHash: string | null;
  promptHash: string | null;
}

/** The shape written to `LinguisticTrace.create` (json columns stringified). */
export interface TraceRow {
  recordingId: string;
  runAt: string;
  triggerBackend: string;
  transcriptSnapshot: string;
  rulesEvaluated: string;
  rulesOutcome: string;
  bedrockInvoked: boolean;
  bedrockModelId: string | null;
  bedrockPromptVersion: number | null;
  bedrockPromptHash: string | null;
  bedrockRenderedPrompt: string | null;
  bedrockRawResponse: string | null;
  bedrockParsed: string | null;
  bedrockProposedRules: string | null;
  finalResult: string;
  attemptSuccess: boolean;
  resultHash: string | null;
  promptHash: string | null;
  overflowKeys: string;
  truncated: boolean;
  ttl: number;
}

/** Assemble the create-input row (pure). json columns are stringified. */
export function buildTraceRow(
  input: TraceInput,
  opts: { now: () => Date; ttlDays?: number },
): TraceRow {
  const nowMs = opts.now().getTime();
  const ttlDays = opts.ttlDays ?? TRACE_TTL_DAYS_DEFAULT;
  const ttl = Math.floor(nowMs / 1000) + ttlDays * SECONDS_PER_DAY;
  const b = input.bedrock;
  return {
    recordingId: input.recordingId,
    runAt: input.runAt,
    triggerBackend: input.triggerBackend,
    transcriptSnapshot: input.transcriptSnapshot,
    rulesEvaluated: JSON.stringify(input.rulesEvaluated ?? []),
    rulesOutcome: JSON.stringify(input.rulesOutcome ?? null),
    bedrockInvoked: b !== null,
    bedrockModelId: b?.modelId ?? null,
    bedrockPromptVersion: b?.promptVersion ?? null,
    bedrockPromptHash: b?.promptHash ?? null,
    bedrockRenderedPrompt: b?.renderedPrompt ?? null,
    bedrockRawResponse: b ? JSON.stringify(b.rawResponse ?? null) : null,
    bedrockParsed: b ? JSON.stringify(b.parsed ?? null) : null,
    bedrockProposedRules: b ? JSON.stringify(b.proposedRules ?? []) : null,
    finalResult: JSON.stringify(input.finalResult ?? null),
    attemptSuccess: input.attemptSuccess,
    resultHash: input.resultHash,
    promptHash: input.promptHash,
    overflowKeys: JSON.stringify({}),
    truncated: false,
    ttl,
  };
}

export interface SizeGuardDeps {
  putObject?: (key: string, body: string) => Promise<void>;
  bucket?: string;
}

/**
 * When the serialized row exceeds {@link MAX_INLINE_TRACE_BYTES}, move the
 * two large text fields (rendered prompt, raw response) out of the row.
 * They go to S3 under `diagnostics/<recordingId>/<runAt>-*` when a bucket +
 * putter are available; otherwise they are dropped (the row still lands —
 * a partial trace beats a failed write). Returns the row to write.
 */
export async function applySizeGuard(row: TraceRow, deps: SizeGuardDeps): Promise<TraceRow> {
  const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
  if (size <= MAX_INLINE_TRACE_BYTES) return row;

  const overflow: { renderedPrompt?: string; rawResponse?: string } = {};
  const canSpill = Boolean(deps.bucket && deps.putObject);
  const prefix = `diagnostics/${row.recordingId}/${row.runAt}`;

  if (row.bedrockRenderedPrompt && canSpill) {
    const key = `${prefix}-prompt.txt`;
    await deps.putObject?.(key, row.bedrockRenderedPrompt);
    overflow.renderedPrompt = key;
  }
  if (row.bedrockRawResponse && canSpill) {
    const key = `${prefix}-response.json`;
    await deps.putObject?.(key, row.bedrockRawResponse);
    overflow.rawResponse = key;
  }

  return {
    ...row,
    bedrockRenderedPrompt: null,
    bedrockRawResponse: null,
    overflowKeys: JSON.stringify(overflow),
    truncated: true,
  };
}

interface TraceWriterClient {
  models: {
    LinguisticTrace: {
      create: (input: TraceRow) => Promise<{ data?: unknown; errors?: unknown }>;
    };
  };
}

export interface PersistTraceDeps extends SizeGuardDeps {
  now: () => Date;
  ttlDays?: number;
}

/**
 * Build → size-guard → write a trace row. Best-effort: any failure is
 * logged and swallowed so the pipeline (and the 30-minute SLA) is never
 * blocked by diagnostics.
 */
export async function persistTrace(
  client: TraceWriterClient,
  input: TraceInput,
  deps: PersistTraceDeps,
): Promise<void> {
  try {
    const row = buildTraceRow(input, { now: deps.now, ttlDays: deps.ttlDays });
    const guarded = await applySizeGuard(row, { putObject: deps.putObject, bucket: deps.bucket });
    const res = await client.models.LinguisticTrace.create(guarded);
    if (res.errors) {
      console.warn('linguistic: LinguisticTrace.create errored (non-fatal)', {
        recordingId: input.recordingId,
        errors: res.errors,
      });
    }
  } catch (err) {
    console.warn('linguistic: trace persist failed (non-fatal)', {
      recordingId: input.recordingId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
