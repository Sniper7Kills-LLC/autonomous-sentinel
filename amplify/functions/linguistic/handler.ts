import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { normalizeParsed } from './normalize';
import { contentMatches, dedupWindow, deterministicMessageId } from './dedup';
import { LinguisticRulesEngine, type RuleMatch } from './rules-engine';
import { loadRulesFromDdb } from './load-rules-ddb';
import { type ConfidenceConfig, isFlagged } from './threshold';
import {
  appendAttempt,
  hashPrompt,
  hashResult,
  shouldSkip,
  type LinguisticAttempt,
  type LinguisticProvider,
} from './attempts';
import {
  renderFallbackPrompt,
  tryBedrockFallback,
  type FallbackOpts,
  type FallbackResult,
} from './ai-fallback';

/**
 * Linguistic Lambda (#433 stage 4).
 *
 * Consumes the linguistic SQS queue. Two message kinds — both
 * published by the Whisper container Lambda (#452):
 *
 *   1. `{ kind: 'transcript', recordingId, transcript, enqueuedAt }`
 *      — happy path. Classify the transcript, create the Message
 *      row, and advance the Recording row to `PUBLISHED` with the
 *      transcript text + new `messageId` in a single Amplify Data
 *      update.
 *
 *   2. `{ kind: 'transcribe-failure', recordingId, reason, enqueuedAt }`
 *      — Whisper hit an error. Linguistic owns the Recording state
 *      machine; it writes `TRANSCRIBE_FAILED` + `failedReason` via
 *      Amplify Data so the portal subscription fires. Without
 *      `kind` (legacy callers) the message is treated as a
 *      transcript for back-compat with any in-flight SQS messages
 *      published before this handler shipped.
 *
 * Why every state change must route here:
 *   - The Whisper Lambda is a container image that deliberately
 *     doesn't carry `aws-amplify` (~5 MB on a ~1.7 GB image is
 *     small but still pointless extra surface).
 *   - Direct DDB writes from the container bypass AppSync's
 *     subscription publisher, which is what the testing portal's
 *     `observeQuery` watches — the portal would silently miss the
 *     final state and stay stuck on `TRANSCRIBING`.
 *
 * Failure of this Lambda itself: mark the Recording `PARSE_FAILED`
 * before rethrowing so SQS redrives. Whisper-side failures land as
 * `TRANSCRIBE_FAILED` regardless of how the linguistic step itself
 * fares — they're recorded the moment the failure message is
 * consumed, before any classifier runs.
 *
 * v1 ships **rule-based parsing only** — the LinguisticConfig /
 * LinguisticRule / LinguisticPromptTemplate models plus Bedrock
 * fallback land in the follow-up.
 */

type MessageType =
  | 'SKYKING'
  | 'SKYBIRD'
  | 'SKYMASTER'
  | 'ALLSTATIONS'
  | 'RADIOCHECK'
  | 'BACKEND'
  | 'DISREGARDED'
  | 'OTHER';

interface TranscriptQueueMessage {
  kind: 'transcript';
  recordingId: string;
  transcript: string;
  /** S3 key of the per-word timestamps JSON sidecar (#92). */
  wordTimestampsKey?: string;
  /** Web-canonical Opus key + size, set when the Whisper container
   * produced the playback derivative (consolidated transcode, #514). */
  webCanonicalKey?: string;
  canonicalSizeBytes?: number;
  enqueuedAt: string;
}

interface TranscribeFailureQueueMessage {
  kind: 'transcribe-failure';
  recordingId: string;
  reason: string;
  enqueuedAt: string;
}

type LinguisticQueueMessage = TranscriptQueueMessage | TranscribeFailureQueueMessage;

interface ClassifyResult {
  type: MessageType;
  confidence: number;
  rule: string;
  /**
   * Fields captured by a DDB rule's `captureMap` (#62/#460). Empty for
   * the inline keyword fallback. `normalizeParsed` prefers these over
   * re-extraction from the transcript.
   */
  fields?: { sender?: string; receiver?: string; body?: string };
  /**
   * Matched rule's prompt version (#64 attempts log). `null` for the
   * inline keyword fallback / no-match, so a future rule set produces a
   * distinct `(provider, version, hash)` key and is not skipped.
   */
  promptVersion?: number | null;
}

/**
 * Confidence assigned to a deterministic DDB-rule regex match. A
 * configured rule is a high-trust signal — well above the 0.8 default
 * auto-publish threshold. Per-type thresholding (#65) lands in a later
 * slice; until then this fixed value drives `flaggedForReview`.
 */
const RULE_MATCH_CONFIDENCE = 0.9;

// Built from a `Record<MessageType, true>` so adding a MessageType to
// the union without listing it here is a compile error — the guard can
// never silently drift from the enum.
const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  Object.keys({
    SKYKING: true,
    SKYBIRD: true,
    SKYMASTER: true,
    ALLSTATIONS: true,
    RADIOCHECK: true,
    BACKEND: true,
    DISREGARDED: true,
    OTHER: true,
  } satisfies Record<MessageType, true>),
);

export interface LinguisticDataClient {
  models: {
    Message: {
      create: (input: {
        id?: string;
        type: MessageType;
        broadcastTs: string;
        body?: string | null;
        sender?: string | null;
        receiver?: string | null;
        confidence?: number | null;
        flaggedForReview?: boolean | null;
        publishedAt?: string | null;
      }) => Promise<{ data: { id?: string } | null; errors?: unknown }>;
      delete: (input: { id: string }) => Promise<{ data: unknown; errors?: unknown }>;
      /**
       * Dedup candidate lookup (#454) — Messages of the same type within
       * the broadcast-time window, excluding soft-deleted. Uses the
       * generic `list` (filter) rather than the type GSI query: Amplify
       * does not generate a `listMessageByType` accessor for the
       * enum-keyed index. (A GSI-backed query would be more efficient at
       * scale — follow-up.)
       */
      list: (input: {
        filter: {
          type: { eq: MessageType };
          broadcastTs: { between: [string, string] };
          deletedAt: { attributeExists: boolean };
        };
        limit?: number;
      }) => Promise<{
        data: Array<{ id: string; type?: string; body?: string | null }> | null;
        errors?: unknown;
      }>;
    };
    Recording: {
      get: (input: { id: string }) => Promise<{
        data: {
          id: string;
          broadcastedAt?: string | null;
          messageId?: string | null;
          linguisticAttempts?: unknown;
        } | null;
        errors?: unknown;
      }>;
      update: (input: {
        id: string;
        messageId?: string | null;
        transcript?: string | null;
        transcriptionStatus?: string;
        transcriptionStatusUpdatedAt?: string;
        transcriptionFailed?: boolean;
        failedReason?: string | null;
        wordTimestampsKey?: string | null;
        webCanonicalKey?: string | null;
        canonicalSizeBytes?: number | null;
        // a.json() (AWSJSON) — written as a JSON string per the #520
        // AuditLog.diff precedent; AppSync returns it parsed on read.
        linguisticAttempts?: string;
      }) => Promise<{ data: unknown; errors?: unknown }>;
    };
    LinguisticConfig: {
      get: (input: { key: string }) => Promise<{
        data: { value?: unknown } | null;
        errors?: unknown;
      }>;
    };
    LinguisticPromptTemplate: {
      list: (input?: { filter?: { isActive: { eq: boolean } } }) => Promise<{
        data: Array<{ body?: string | null; version?: number | null }> | null;
        errors?: unknown;
      }>;
    };
  };
}

/** Minimal rules-engine surface the handler depends on (test-injectable). */
export interface RulesMatcher {
  tryMatch(transcript: string): Promise<RuleMatch | null>;
}

export interface LinguisticDeps {
  dataClient?: LinguisticDataClient;
  rulesEngine?: RulesMatcher;
  /** Bedrock AI fallback (#63). Injected in tests; defaults to the real call. */
  bedrockFallback?: (transcript: string, opts?: FallbackOpts) => Promise<FallbackResult | null>;
  now?: () => Date;
  uuid?: () => string;
}

let injected: LinguisticDeps = {};

export function __setDeps(deps: LinguisticDeps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
  // Drop the cold-start engine singleton too, so a test that does not
  // inject `rulesEngine` starts from a clean slate rather than reusing
  // a previously-built production engine.
  cachedRulesEngine = undefined;
}

let cachedRulesEngine: LinguisticRulesEngine | undefined;
function rulesEngine(): RulesMatcher {
  if (injected.rulesEngine) return injected.rulesEngine;
  // One engine per cold start; its TTL cache spans hot invocations.
  if (!cachedRulesEngine) cachedRulesEngine = new LinguisticRulesEngine(loadRulesFromDdb);
  return cachedRulesEngine;
}

let cachedDataClient: LinguisticDataClient | undefined;
async function dataClient(): Promise<LinguisticDataClient> {
  if (injected.dataClient) return injected.dataClient;
  if (cachedDataClient) return cachedDataClient;
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedDataClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as LinguisticDataClient;
  return cachedDataClient;
}

function nowDate(): Date {
  return (injected.now ?? (() => new Date()))();
}

/**
 * Detects a `DynamoDB:ConditionalCheckFailedException` in an Amplify
 * Data response's `errors[]`. Two callers:
 *   - `Recording.update` (conditional on `attribute_exists(id)`): the
 *     row was deleted in flight (#459) — drop the SQS message cleanly.
 *   - `Message.create` (conditional on `attribute_not_exists(id)`): a
 *     concurrent identical capture already created the deterministic-id
 *     Message (#454 dedup race) — link to it instead.
 */
function isConditionalCheckError(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) =>
      e != null &&
      typeof e === 'object' &&
      (e as { errorType?: unknown }).errorType === 'DynamoDB:ConditionalCheckFailedException',
  );
}

/**
 * Coarse keyword-driven classifier. Highest-specificity rule wins.
 */
export function classify(transcript: string): ClassifyResult {
  const t = transcript.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) {
    return { type: 'OTHER', confidence: 0.1, rule: 'empty-transcript' };
  }
  if (/\bsky\s*king\b/.test(t)) {
    return { type: 'SKYKING', confidence: 0.85, rule: 'skyking-preamble' };
  }
  if (/\bsky\s*master\b/.test(t)) {
    return { type: 'SKYMASTER', confidence: 0.8, rule: 'skymaster-preamble' };
  }
  if (/\bsky\s*bird\b/.test(t)) {
    return { type: 'SKYBIRD', confidence: 0.8, rule: 'skybird-preamble' };
  }
  if (/\b(disregard|disregarded)\b/.test(t)) {
    return {
      type: 'DISREGARDED',
      confidence: 0.75,
      rule: 'disregard-keyword',
    };
  }
  if (/\bradio\s*check\b/.test(t) || /\btest\s*count\b/.test(t)) {
    return { type: 'RADIOCHECK', confidence: 0.85, rule: 'radio-check' };
  }
  if (/\ball\s*stations?\b/.test(t)) {
    return { type: 'ALLSTATIONS', confidence: 0.75, rule: 'all-stations' };
  }
  return { type: 'OTHER', confidence: 0.3, rule: 'fallback' };
}

/**
 * Classify via the admin-configurable DDB rules engine (#62/#460),
 * falling back to the inline keyword `classify()` when no rule matches.
 *
 * The fallback is deliberate: with zero seeded `LinguisticRule` rows
 * (or a transient loader error) the engine returns no match and the
 * pipeline behaves exactly as before this slice — so shipping the
 * wiring ahead of seeding the rules is non-regressive.
 *
 * A rule match wins and carries its `captureMap` fields through to
 * `normalizeParsed`. An unknown `messageType` on a matched rule is
 * treated as no-match (falls back) rather than writing a bad enum.
 */
export async function classifyWithRules(
  transcript: string,
  engine: RulesMatcher,
): Promise<ClassifyResult> {
  let match: RuleMatch | null = null;
  try {
    match = await engine.tryMatch(transcript);
  } catch (err) {
    // A rules-engine / loader failure must never sink a transcript —
    // fall back to the inline classifier.
    console.warn('linguistic: rules engine errored; using inline classifier', {
      err: err instanceof Error ? err.message : String(err),
    });
    return classify(transcript);
  }
  if (!match || !KNOWN_MESSAGE_TYPES.has(match.message.messageType)) {
    return classify(transcript);
  }
  const f = match.message.fields;
  return {
    type: match.message.messageType as MessageType,
    confidence: RULE_MATCH_CONFIDENCE,
    rule: `rule:${match.ruleId}`,
    promptVersion: match.promptVersion,
    fields: {
      ...(f.sender ? { sender: f.sender } : {}),
      ...(f.receiver ? { receiver: f.receiver } : {}),
      ...(f.body ? { body: f.body } : {}),
    },
  };
}

/** Provider for the rules path attempt log (#64). */
const RULES_PROVIDER: LinguisticProvider = 'rules';
/** Provider for the Bedrock AI-fallback attempt log (#63/#64). */
const BEDROCK_PROVIDER: LinguisticProvider = 'bedrock';

/** Resolve the Bedrock fallback (injected in tests, real call in prod). */
function bedrockFallback(transcript: string, opts?: FallbackOpts): Promise<FallbackResult | null> {
  return (injected.bedrockFallback ?? tryBedrockFallback)(transcript, opts);
}

/**
 * Stable JSON of the parsed result for the attempt `resultHash` —
 * fixed key order + omitted blanks so the same parse always hashes the
 * same regardless of field insertion order.
 */
function canonicalResultJson(parsed: {
  type: string;
  body: string;
  sender?: string;
  receiver?: string;
}): string {
  return JSON.stringify({
    body: parsed.body,
    receiver: parsed.receiver ?? null,
    sender: parsed.sender ?? null,
    type: parsed.type,
  });
}

/**
 * Coerce a Recording's `linguisticAttempts` (a.json()) to an array.
 * AppSync returns AWSJSON parsed (array) on read; a JSON string is
 * tolerated for older/seeded rows. A present-but-unusable value (an
 * object, number, etc.) is warned — silently dropping a non-empty log
 * would erase prior attempt history.
 */
function coerceAttempts(value: unknown): LinguisticAttempt[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as LinguisticAttempt[];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as LinguisticAttempt[];
    } catch {
      // fall through to the warn below
    }
  }
  console.warn('linguistic: unusable linguisticAttempts value; treating as empty', {
    type: typeof value,
  });
  return [];
}

/**
 * Resolve the active Bedrock prompt template (self-improving loop). Reads
 * the `LinguisticPromptTemplate` row with `isActive=true` so an admin's
 * edited prompt (version-bumped) overrides the bundled markdown default.
 * Returns `{}` on any miss — `ai-fallback` then uses its git-reviewed
 * `DEFAULT_PROMPT_TEMPLATE`, so an env with no prompt row still runs.
 */
async function loadActivePromptTemplate(
  client: LinguisticDataClient,
): Promise<{ body?: string; version?: number }> {
  try {
    const res = await client.models.LinguisticPromptTemplate.list({
      filter: { isActive: { eq: true } },
    });
    if (res.errors || !res.data || res.data.length === 0) return {};
    // The model mandates one active row per promptId; if several slip
    // through, the highest version wins (matches the model docstring).
    const active = [...res.data].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
    if (active?.body) {
      return {
        body: active.body,
        ...(typeof active.version === 'number' ? { version: active.version } : {}),
      };
    }
    return {};
  } catch (err) {
    console.warn('linguistic: active prompt-template load failed; using default', {
      err: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** LinguisticConfig key holding the per-type confidence-threshold map. */
const CONFIDENCE_THRESHOLDS_KEY = 'CONFIDENCE_THRESHOLDS';

/**
 * Load the admin-tunable per-type confidence thresholds (#65) from the
 * `CONFIDENCE_THRESHOLDS` LinguisticConfig row. The row's `value` is a
 * `{ <messageType>: number, DEFAULT?: number }` map. Read per
 * invocation (hot-reload, per CLAUDE.md) — a single keyed get is cheap.
 *
 * Any miss (no row, query error, malformed value) resolves to an empty
 * map, so `resolveThreshold` falls back to its DEFAULT then the
 * hard-coded 0.8 — a fresh env with no config row still gates safely.
 */
async function loadConfidenceConfig(client: LinguisticDataClient): Promise<ConfidenceConfig> {
  const empty: ConfidenceConfig = { confidenceThresholds: {} };
  try {
    const res = await client.models.LinguisticConfig.get({ key: CONFIDENCE_THRESHOLDS_KEY });
    if (res.errors || !res.data) return empty;
    // `a.json()` reads back as a parsed object, but tolerate a JSON
    // string too (older writers / direct DDB seeds).
    let value: unknown = res.data.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return empty;
      }
    }
    if (!value || typeof value !== 'object') return empty;
    // Pass the raw map through — resolveThreshold validates each entry's
    // range and ignores out-of-range / non-numeric values.
    return { confidenceThresholds: value as Record<string, number> };
  } catch (err) {
    console.warn('linguistic: confidence-threshold load failed; using defaults', {
      err: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

interface RawLinguisticMessage {
  kind?: 'transcript' | 'transcribe-failure';
  recordingId?: string;
  transcript?: string;
  wordTimestampsKey?: string;
  webCanonicalKey?: string;
  canonicalSizeBytes?: number;
  reason?: string;
  enqueuedAt?: string;
}

export function parseMessage(body: string): LinguisticQueueMessage {
  const parsed = JSON.parse(body) as RawLinguisticMessage;
  if (!parsed.recordingId) {
    throw new Error(`linguistic: SQS body missing recordingId: ${JSON.stringify(parsed)}`);
  }
  if (parsed.kind === 'transcribe-failure') {
    if (typeof parsed.reason !== 'string') {
      throw new Error(
        `linguistic: transcribe-failure body missing reason: ${JSON.stringify(parsed)}`,
      );
    }
    return {
      kind: 'transcribe-failure',
      recordingId: parsed.recordingId,
      reason: parsed.reason,
      enqueuedAt: parsed.enqueuedAt ?? nowDate().toISOString(),
    };
  }
  // Treat anything else (including legacy messages without `kind`)
  // as a transcript message for back-compat.
  if (typeof parsed.transcript !== 'string') {
    throw new Error(`linguistic: transcript body missing transcript: ${JSON.stringify(parsed)}`);
  }
  return {
    kind: 'transcript',
    recordingId: parsed.recordingId,
    transcript: parsed.transcript,
    wordTimestampsKey:
      typeof parsed.wordTimestampsKey === 'string' && parsed.wordTimestampsKey.length > 0
        ? parsed.wordTimestampsKey
        : undefined,
    webCanonicalKey:
      typeof parsed.webCanonicalKey === 'string' && parsed.webCanonicalKey.length > 0
        ? parsed.webCanonicalKey
        : undefined,
    canonicalSizeBytes:
      typeof parsed.canonicalSizeBytes === 'number' ? parsed.canonicalSizeBytes : undefined,
    enqueuedAt: parsed.enqueuedAt ?? nowDate().toISOString(),
  };
}

async function processTranscript(msg: TranscriptQueueMessage): Promise<void> {
  const client = await dataClient();
  // Per-type confidence threshold (#65) — admin-tunable via the
  // CONFIDENCE_THRESHOLDS LinguisticConfig row; falls back to 0.8.
  const confidenceConfig = await loadConfidenceConfig(client);

  // Fetch the Recording first: its `linguisticAttempts` log (#64) gates
  // the paid Bedrock call below, and `broadcastedAt` drives the dedup
  // window. Falls back to enqueuedAt when absent (testing-portal upload).
  const rec = await client.models.Recording.get({ id: msg.recordingId });
  const broadcastTime = rec.data?.broadcastedAt ?? msg.enqueuedAt;
  const existingAttempts = coerceAttempts(rec.data?.linguisticAttempts);

  let result = await classifyWithRules(msg.transcript, rulesEngine());

  // Attempt provenance — rules path by default; switched to bedrock below.
  let attemptProvider: LinguisticProvider = RULES_PROVIDER;
  let attemptPromptVersion: number | null = result.promptVersion ?? null;
  let attemptPromptHash: string | null = null;
  let attemptSuccess = true;

  // Bedrock AI fallback (#63) — runs ONLY when the rules engine AND the
  // inline keyword classifier both miss (the `OTHER`/'fallback' case),
  // so the paid model call is reserved for genuinely-unrecognized
  // transcripts.
  if (result.rule === 'fallback') {
    // Resolve the admin-editable prompt (active DB template, else the
    // git-reviewed markdown default) and thread it through both the hash
    // (for the attempt skip key) and the model call.
    const tmpl = await loadActivePromptTemplate(client);
    const fbOpts: FallbackOpts = {
      ...(tmpl.body ? { promptTemplate: tmpl.body } : {}),
      ...(typeof tmpl.version === 'number' ? { promptVersion: tmpl.version } : {}),
    };
    const {
      rendered,
      promptVersion: bedrockVersion,
      modelId,
    } = renderFallbackPrompt(msg.transcript, fbOpts);
    attemptProvider = BEDROCK_PROVIDER;
    attemptPromptVersion = bedrockVersion;
    attemptPromptHash = hashPrompt(rendered);
    // Always invoke on the fallback path. We deliberately do NOT skip the
    // call when a prior bedrock success is logged: the attempt log stores
    // only the result *hash*, not the parsed type/fields, so a skip would
    // leave `result` as OTHER and the dedup below would create a SECOND
    // (OTHER-typed) Message instead of linking to the prior bedrock-typed
    // one. The deterministic-id dedup already makes a redrive idempotent
    // (same parse → same id → link); re-invoking on a rare redrive is the
    // safe trade. A cost-skip that reuses the stored parse is a follow-up.
    const fb = await bedrockFallback(msg.transcript, fbOpts);
    if (fb && KNOWN_MESSAGE_TYPES.has(fb.message.type)) {
      result = {
        type: fb.message.type as MessageType,
        confidence: fb.message.confidence,
        rule: `bedrock:${modelId}`,
        promptVersion: bedrockVersion,
        fields: {
          ...(fb.message.sender ? { sender: fb.message.sender } : {}),
          ...(fb.message.receiver ? { receiver: fb.message.receiver } : {}),
          ...(fb.message.body ? { body: fb.message.body } : {}),
        },
      };
    } else {
      // Bedrock couldn't parse it either — keep the OTHER result but log
      // a FAILED bedrock attempt so a future bedrock-prompt bump (#66)
      // reprocesses this recording.
      attemptSuccess = false;
    }
  }

  // Turn the raw transcript into log-format fields: NATO-decode the
  // body, collapse double broadcasts, extract sender/receiver (#506).
  // Rule/Bedrock-captured fields win over re-extraction. The raw
  // transcript stays on the Recording row (source of truth); the
  // Message carries the derived/normalized form.
  const normalized = normalizeParsed({
    type: result.type,
    transcript: msg.transcript,
    ...(result.fields?.sender ? { sender: result.fields.sender } : {}),
    ...(result.fields?.receiver ? { receiver: result.fields.receiver } : {}),
    ...(result.fields?.body ? { body: result.fields.body } : {}),
  });
  // `||` not `??`: decodePhonetic returns "" for a body with no
  // decodable letters — fall back to the raw transcript.
  const canonical = normalized.body || msg.transcript;
  const ts = nowDate().toISOString();

  // Attempt log (#64) — record this invocation's provenance unless an
  // identical success is already logged. `resultHash` is null on a
  // failed attempt. This log is the substrate the reprocess-on-bump
  // gate (#66/#481) reads to decide which recordings to re-run.
  const skipKey = {
    provider: attemptProvider,
    promptVersion: attemptPromptVersion,
    promptHash: attemptPromptHash,
  };
  const resultHash = attemptSuccess
    ? hashResult(
        canonicalResultJson({
          type: result.type,
          body: canonical,
          sender: normalized.sender,
          receiver: normalized.receiver,
        }),
      )
    : null;
  const attempts = shouldSkip(existingAttempts, skipKey)
    ? existingAttempts
    : appendAttempt(
        existingAttempts,
        {
          provider: attemptProvider,
          promptVersion: attemptPromptVersion,
          promptHash: attemptPromptHash,
          resultHash,
          success: attemptSuccess,
        },
        { now: nowDate },
      );

  // Dedup (#454): multiple SDRs of one broadcast + SQS redrives link to
  // a single Message. Find an existing Message of the same type within
  // the broadcast-time window whose content matches (exact decoded for
  // ALLSTATIONS/SKYKING, token similarity otherwise).
  let targetMessageId: string | undefined;
  const win = dedupWindow(broadcastTime);
  const candidates = await client.models.Message.list({
    filter: {
      type: { eq: result.type },
      broadcastTs: { between: [win.start, win.end] },
      // Never link to a soft-deleted Message (the model mandates
      // deletedAt-null on list/browse).
      deletedAt: { attributeExists: false },
    },
  });
  if (candidates.errors) {
    // Don't block publishing on a dedup-query hiccup — fall through to create.
    console.warn('linguistic: dedup candidate query errored; creating new Message', {
      recordingId: msg.recordingId,
      errors: candidates.errors,
    });
  } else {
    const match = (candidates.data ?? []).find((c) =>
      contentMatches(result.type, canonical, c.body ?? ''),
    );
    if (match) targetMessageId = match.id;
  }

  if (targetMessageId) {
    console.info('linguistic: linked Recording to existing Message (dedup)', {
      recordingId: msg.recordingId,
      messageId: targetMessageId,
    });
  } else {
    // Deterministic id = create-race guard: a concurrent identical
    // capture computes the same id, so its create collides
    // (attribute_exists → ConditionalCheckFailed) and links instead.
    const messageId = deterministicMessageId(result.type, canonical, broadcastTime);
    const created = await client.models.Message.create({
      id: messageId,
      type: result.type,
      broadcastTs: broadcastTime,
      body: canonical,
      ...(normalized.sender ? { sender: normalized.sender } : {}),
      ...(normalized.receiver ? { receiver: normalized.receiver } : {}),
      confidence: result.confidence,
      flaggedForReview: isFlagged(
        { type: result.type, confidence: result.confidence },
        confidenceConfig,
      ),
      publishedAt: ts,
    });
    if (created.errors) {
      if (isConditionalCheckError(created.errors)) {
        // A Message with this deterministic id already exists (a
        // concurrent identical capture won the race) — link to it.
        targetMessageId = messageId;
        console.info('linguistic: dedup create collided, linking to existing', {
          recordingId: msg.recordingId,
          messageId,
        });
      } else {
        throw new Error(
          `linguistic: Message.create returned errors: ${JSON.stringify(created.errors)}`,
        );
      }
    } else {
      targetMessageId = created.data?.id ?? messageId;
    }
  }

  // Link the Recording → Message + advance to PUBLISHED in one update.
  const updated = await client.models.Recording.update({
    id: msg.recordingId,
    messageId: targetMessageId,
    transcript: msg.transcript,
    transcriptionStatus: 'PUBLISHED',
    transcriptionStatusUpdatedAt: ts,
    // Persist the appended attempt log (#64). Stringified for AWSJSON.
    linguisticAttempts: JSON.stringify(attempts),
    ...(msg.wordTimestampsKey ? { wordTimestampsKey: msg.wordTimestampsKey } : {}),
    // Web-canonical Opus produced by the Whisper container (#514).
    ...(msg.webCanonicalKey ? { webCanonicalKey: msg.webCanonicalKey } : {}),
    ...(typeof msg.canonicalSizeBytes === 'number'
      ? { canonicalSizeBytes: msg.canonicalSizeBytes }
      : {}),
  });
  if (updated.errors) {
    if (isConditionalCheckError(updated.errors)) {
      // Recording was deleted in flight. Under dedup the Message may be
      // shared by other recordings, so we must NOT delete it (that would
      // orphan their link). Drop the SQS message cleanly; a Message left
      // with zero recordings is valid per the domain model (v3 archive /
      // recording-less) and swept by the future janitor (#459).
      console.warn('linguistic: Recording deleted in flight, dropping (Message left intact)', {
        recordingId: msg.recordingId,
        messageId: targetMessageId,
      });
      return;
    }
    throw new Error(
      `linguistic: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }

  console.info('linguistic: published Message', {
    recordingId: msg.recordingId,
    messageId: targetMessageId,
    type: result.type,
    confidence: result.confidence,
    rule: result.rule,
  });
}

async function processTranscribeFailure(msg: TranscribeFailureQueueMessage): Promise<void> {
  const client = await dataClient();
  const ts = nowDate().toISOString();
  const updated = await client.models.Recording.update({
    id: msg.recordingId,
    transcriptionStatus: 'TRANSCRIBE_FAILED',
    transcriptionFailed: true,
    failedReason: msg.reason.slice(0, 1024),
    transcriptionStatusUpdatedAt: ts,
  });
  if (updated.errors) {
    if (isConditionalCheckError(updated.errors)) {
      // Recording deleted in flight — nothing to mark, no Message was
      // created on this path. Drop cleanly so SQS doesn't redrive (#459).
      console.warn('linguistic: Recording deleted in flight, dropping transcribe-failure message', {
        recordingId: msg.recordingId,
      });
      return;
    }
    throw new Error(
      `linguistic: Recording.update (TRANSCRIBE_FAILED) returned errors: ${JSON.stringify(
        updated.errors,
      )}`,
    );
  }
  console.info('linguistic: marked Recording TRANSCRIBE_FAILED', {
    recordingId: msg.recordingId,
    reasonLen: msg.reason.length,
  });
}

async function markFailed(recordingId: string, reason: string): Promise<void> {
  try {
    const client = await dataClient();
    await client.models.Recording.update({
      id: recordingId,
      transcriptionStatus: 'PARSE_FAILED',
      transcriptionFailed: true,
      transcriptionStatusUpdatedAt: nowDate().toISOString(),
      failedReason: reason.slice(0, 1024),
    });
  } catch (err) {
    console.error('linguistic: failed to mark Recording PARSE_FAILED', {
      recordingId,
      err: String(err),
    });
  }
}

// `_context` / `_callback` declared explicitly so the test fixtures
// that pass all three Lambda-runtime arguments don't trip CodeQL's
// "Superfluous trailing arguments" rule.
export const handler: SQSHandler = async (event: SQSEvent, _context, _callback) => {
  for (const record of event.Records) {
    let msg: LinguisticQueueMessage;
    try {
      msg = parseMessage(record.body);
    } catch (err) {
      console.error('linguistic: invalid SQS body, skipping', {
        body: record.body,
        err: String(err),
      });
      continue;
    }
    try {
      if (msg.kind === 'transcribe-failure') {
        await processTranscribeFailure(msg);
      } else {
        await processTranscript(msg);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('linguistic: failed', {
        recordingId: msg.recordingId,
        kind: msg.kind,
        err: reason,
      });
      // Only mark PARSE_FAILED on transcript-path failures. Failures
      // while writing TRANSCRIBE_FAILED (rare; AppSync outage etc.)
      // don't overwrite the row — let SQS redrive surface the
      // upstream Whisper failure rather than mask it with our own
      // PARSE_FAILED.
      if (msg.kind === 'transcript') {
        await markFailed(msg.recordingId, reason);
      }
      throw err;
    }
  }
};
