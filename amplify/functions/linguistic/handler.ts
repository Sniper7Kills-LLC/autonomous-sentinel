import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { normalizeParsed } from './normalize';
import { contentMatches, dedupWindow, deterministicMessageId } from './dedup';
import {
  LinguisticRulesEngine,
  type RuleMatch,
  type RuleSummary,
  type TracedMatch,
} from './rules-engine';
import { persistTrace, type TraceInput, type TraceBedrock, type TraceRow } from './trace';
import { makeDiagnosticsPutObject } from './trace-s3';
import { callsignCandidates, loadApprovedCallsigns, suggestCallsigns } from './callsign-suggest';
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
  type ProposedRule,
  type TranscriptForReconcile,
} from './ai-fallback';
import { coerceTranscripts, upsertTranscript, selectPrimary } from './transcripts';
import { isTerminalRecordingStatus } from '../_shared/recording-status';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';
import { recomputeReputation, type ReputationHelperClient } from '../../data/reputation-helper';

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
  /**
   * Which transcription backend produced this transcript (#593):
   * `whisper-local`, `amazon-transcribe`, … Used to key the per-backend
   * `Recording.transcripts` collection (UPSERT by backend, never replace
   * the other backends' entries). Absent on legacy/in-flight messages
   * published before #593 — defaults to `whisper-local` (the only
   * historical producer) so old messages still slot into the collection.
   */
  backend?: string;
  /** S3 key of the per-word timestamps JSON sidecar (#92). */
  wordTimestampsKey?: string;
  /** Web-canonical Opus key + size, set when the Whisper container
   * produced the playback derivative (consolidated transcode, #514). */
  webCanonicalKey?: string;
  canonicalSizeBytes?: number;
  /** Overall whisper confidence (#581): mean per-token `p` in [0,1].
   * Absent when the transcriber emitted no per-token probabilities. */
  transcriptionConfidence?: number;
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
       * Read the prior (M_old) Message on a re-run (#556). Its
       * `submitterId` distinguishes a pipeline-created message (null) from
       * a recording-less manual submission (set) — the latter is never
       * superseded by a re-run.
       */
      get: (input: { id: string }) => Promise<{
        data: {
          id: string;
          submitterId?: string | null;
          deletedAt?: string | null;
          // Discriminates a supersede soft-delete (#556) from an
          // admin-intentional delete on re-link recovery (#599): only the
          // former is auto-recovered.
          deletedReason?: string | null;
        } | null;
        errors?: unknown;
      }>;
      /**
       * Soft-delete the superseded M_old on a re-run that produced a
       * genuinely different parse (#556). Sets `deletedAt` (+ `deletedBy`
       * = null: a re-run is a system action, the AuditLog carries the
       * actor when one exists).
       */
      update: (input: {
        id: string;
        deletedAt?: string | null;
        deletedBy?: string | null;
        deletedReason?: string | null;
        // Re-publish timestamp set when a re-run recovers a soft-deleted
        // Message it deterministically re-maps onto (#599).
        publishedAt?: string | null;
      }) => Promise<{ data: unknown; errors?: unknown }>;
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
          // Current pipeline status — read to skip the cosmetic PARSING
          // write when the recording is already terminal (#433).
          transcriptionStatus?: string | null;
          broadcastedAt?: string | null;
          messageId?: string | null;
          // Source media for the low-confidence Amazon Transcribe escalation
          // re-enqueue (#588): the dispatcher forwards `originalKey` to the
          // backend, which reads it to fetch the audio.
          originalKey?: string | null;
          // Low-confidence escalation marker (#588). Its presence is the
          // loop guard — an already-escalated recording is never escalated
          // again (never bounce whisper↔transcribe).
          escalatedAt?: string | null;
          linguisticAttempts?: unknown;
          // Per-backend transcript collection (#593) — a.json(), read back
          // as a parsed array (or a JSON string on older rows).
          transcripts?: unknown;
        } | null;
        errors?: unknown;
      }>;
      update: (input: {
        id: string;
        messageId?: string | null;
        transcript?: string | null;
        // Per-backend transcript collection (#593). Written as a JSON
        // string (AWSJSON), mirroring the linguisticAttempts precedent.
        transcripts?: string;
        // Stable broadcast time persisted on first pipeline run so re-runs
        // reuse it and an identical re-parse stays idempotent (#556).
        broadcastedAt?: string | null;
        transcriptionStatus?: string;
        transcriptionStatusUpdatedAt?: string;
        transcriptionFailed?: boolean;
        failedReason?: string | null;
        wordTimestampsKey?: string | null;
        webCanonicalKey?: string | null;
        canonicalSizeBytes?: number | null;
        // Overall whisper confidence (#581), [0,1] or null.
        transcriptionConfidence?: number | null;
        // Low-confidence escalation marker (#588) — set the one time this
        // recording is escalated to Amazon Transcribe.
        escalatedAt?: string | null;
        // a.json() (AWSJSON) — written as a JSON string per the #520
        // AuditLog.diff precedent; AppSync returns it parsed on read.
        linguisticAttempts?: string;
      }) => Promise<{ data: unknown; errors?: unknown }>;
      /**
       * GSI accessor auto-generated for `i('messageId')` on Recording
       * (#556). Used to count a superseded M_old's remaining Recordings:
       * a re-run only deletes M_old when this Recording is its ONLY one.
       */
      listRecordingByMessageId: (input: { messageId: string }) => Promise<{
        data: Array<{ id: string; deletedAt?: string | null }> | null;
        errors?: unknown;
      }>;
    };
    LinguisticConfig: {
      get: (input: { key: string }) => Promise<{
        data: { value?: unknown } | null;
        errors?: unknown;
      }>;
    };
    LinguisticPromptTemplate: {
      list: (input?: {
        filter?: { promptId: { eq: string }; isActive: { eq: boolean } };
      }) => Promise<{
        data: Array<{ body?: string | null; version?: number | null }> | null;
        errors?: unknown;
      }>;
    };
    LinguisticRule: {
      create: (input: {
        pattern: string;
        messageType: string;
        component: 'TYPE' | 'SENDER' | 'RECEIVER' | 'BODY';
        appliesToType?: string | null;
        captureMap: string;
        priority: number;
        enabled: boolean;
        confidence: number;
        promptVersion: number;
        notes?: string | null;
      }) => Promise<{ data: { id?: string } | null; errors?: unknown }>;
    };
    /** Per-run deep-debug trace (#744). Written best-effort after publish. */
    LinguisticTrace: {
      create: (input: TraceRow) => Promise<{ data?: unknown; errors?: unknown }>;
    };
    /**
     * Callsign dictionary (#776 suggest, #778 prompt feed). The handler
     * reads approved entries to prime Bedrock + suggests unknown parsed
     * callsigns as AI_SUGGESTED/approved=false rows for admin review.
     */
    Callsign: {
      list: (input?: Record<string, unknown>) => Promise<{
        data: Array<{ id: string; normalized?: string | null; variants?: string[] | null }> | null;
        errors?: unknown;
      }>;
      create: (input: {
        normalized: string;
        source: 'LEGACY' | 'ADMIN' | 'AI_SUGGESTED';
        approved: boolean;
        confidence?: number | null;
        notes?: string | null;
      }) => Promise<{ data: { id?: string } | null; errors?: unknown }>;
    };
  };
}

/** Minimal rules-engine surface the handler depends on (test-injectable). */
export interface RulesMatcher {
  tryMatch(transcript: string): Promise<RuleMatch | null>;
  /** Active ruleset summary for the AI-refine context (#544b). Optional. */
  snapshot?(): Promise<RuleSummary[]>;
  /** Traced match for the #744 diagnostics trace. Optional (best-effort). */
  tryMatchTraced?(transcript: string): Promise<TracedMatch>;
}

/** AuditLog writer (#556 supersede-on-re-run). Injected in tests. */
export type LinguisticAuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

/**
 * Transcribe-queue escalation message (#588). Carries `recordingId` +
 * `originalKey` (the dispatcher forwards the body verbatim to the backend,
 * which reads `originalKey` to fetch the audio) plus a `backendOverride`
 * so the dispatcher (#587/#589) routes this re-transcription to
 * `amazon-transcribe`.
 *
 * `contentHash` is intentionally OMITTED: on a re-transcribe the Recording
 * already exists, and neither the dispatcher (`parseDispatchMessage` reads
 * only `recordingId` + `backendOverride`) nor the transcribe-aws backend
 * (reads `recordingId` + `originalKey`) consumes it. Sending an empty
 * string would publish a bogus dedup-key value; sending nothing is correct.
 */
export interface TranscribeEscalationMessage {
  recordingId: string;
  originalKey: string;
  enqueuedAt: string;
  backendOverride: string;
}

/** Re-enqueues a recording onto the transcribe queue (#588). Injected in tests. */
export type EscalateFn = (msg: TranscribeEscalationMessage) => Promise<void>;

export interface LinguisticDeps {
  dataClient?: LinguisticDataClient;
  rulesEngine?: RulesMatcher;
  /** Bedrock AI fallback (#63). Injected in tests; defaults to the real call. */
  bedrockFallback?: (transcript: string, opts?: FallbackOpts) => Promise<FallbackResult | null>;
  /** AuditLog writer for the M_old supersede entry (#556). */
  audit?: LinguisticAuditFn;
  /** Low-confidence Amazon Transcribe escalation re-enqueue (#588). */
  escalate?: EscalateFn;
  /** Reputation recompute on Recording publish (#480). Injected in tests. */
  repRecompute?: (client: ReputationHelperClient, userId: string) => Promise<number>;
  /** Deep-debug trace writer (#744). Injected in tests; defaults to persistTrace. */
  traceWriter?: (input: TraceInput) => Promise<void>;
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
  // No `= null` initialiser: the try below assigns it and the catch returns,
  // so it is always assigned before the read at `if (!match ...)` — an
  // initialiser is dead per eslint 10's `no-useless-assignment`.
  let match: RuleMatch | null;
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
    confidence: match.confidence,
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

/**
 * Confidence at/above which an AI-proposed rule auto-activates
 * (`enabled=true`); below it the rule lands disabled for admin review
 * (#544 hybrid activation). Corpus validation (#545) will add a second
 * gate. Default priority for AI rules.
 */
const RULE_AUTO_ACTIVATE_BAR = 0.85;
const AI_RULE_PRIORITY = 50;
const AI_RULE_DEFAULT_CONFIDENCE = 0.7;

/** Max rules listed in the AI-refine context, to bound prompt size. */
const CONTEXT_RULE_LIMIT = 50;

/**
 * Build the dynamic context fed to Bedrock (#544b): the failed
 * rule-engine attempt + the current active ruleset, so the model refines
 * existing rules instead of only generating fresh ones.
 */
/** Max known callsigns listed in the Bedrock context, to bound prompt size (#778). */
const CONTEXT_CALLSIGN_LIMIT = 80;

function buildBedrockContext(
  result: ClassifyResult,
  summaries: RuleSummary[],
  knownCallsigns: string[] = [],
): string {
  const lines = ['The rules engine could not confidently parse this transcript.'];
  const fieldsNote =
    result.fields && Object.keys(result.fields).length > 0
      ? ` fields=${JSON.stringify(result.fields)}`
      : '';
  lines.push(`Its best attempt: type=${result.type} confidence=${result.confidence}${fieldsNote}`);
  if (summaries.length > 0) {
    lines.push(
      '',
      'Current active rules — refine or extend these (propose improved versions to raise confidence next time):',
    );
    for (const s of summaries.slice(0, CONTEXT_RULE_LIMIT)) {
      const applies = s.appliesToType ? ` applies=${s.appliesToType}` : '';
      lines.push(
        `- [${s.component}${applies}] ${s.messageType} /${s.pattern}/ (conf ${s.confidence})`,
      );
    }
    if (summaries.length > CONTEXT_RULE_LIMIT) {
      lines.push(`- …and ${summaries.length - CONTEXT_RULE_LIMIT} more.`);
    }
  } else {
    lines.push('', 'There are no rules yet — propose rules to bootstrap the ruleset.');
  }
  // Known-callsign priming (#778): bias sender/receiver extraction toward the
  // curated dictionary. Bounded to keep the prompt small.
  if (knownCallsigns.length > 0) {
    const shown = knownCallsigns.slice(0, CONTEXT_CALLSIGN_LIMIT);
    lines.push(
      '',
      `Known callsigns (prefer these for sender/receiver when they fit): ${shown.join(', ')}` +
        (knownCallsigns.length > CONTEXT_CALLSIGN_LIMIT
          ? ` …and ${knownCallsigns.length - CONTEXT_CALLSIGN_LIMIT} more.`
          : ''),
    );
  }
  return lines.join('\n');
}

/**
 * Identity of a rule for dedup purposes (#575): a rule is "the same" as
 * another when its component, appliesToType, and (whitespace-trimmed)
 * pattern all match. messageType is intentionally excluded — the bug is
 * exact-duplicate accumulation of the same matcher, and a TYPE rule's
 * pattern + a field rule's (component, appliesToType) already pin the
 * classification context. The pattern is a regex, so only outer
 * whitespace is trimmed; case + internal spacing are significant.
 */
export function ruleDedupKey(
  component: string,
  appliesToType: string | null | undefined,
  pattern: string,
): string {
  return `${component} ${appliesToType ?? ''} ${pattern.trim()}`;
}

/**
 * Drop proposed rules that duplicate an already-active rule (#575). The
 * AI re-proposes matchers it has emitted before; without this guard the
 * LinguisticRule table accumulates identical rows on every fallback.
 * Dedups against the supplied existing ruleset AND within the batch
 * itself (the model can emit the same rule twice in one response).
 */
export function filterNewProposedRules(
  proposed: ProposedRule[],
  existing: readonly { component: string; appliesToType: string | null; pattern: string }[],
): ProposedRule[] {
  const seen = new Set(existing.map((e) => ruleDedupKey(e.component, e.appliesToType, e.pattern)));
  const out: ProposedRule[] = [];
  for (const r of proposed) {
    const key = ruleDedupKey(r.component, r.appliesToType, r.pattern);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Persist the model's proposed per-component rules (#544). Hybrid
 * activation: rules at/above the auto-activate bar go live; the rest
 * land disabled for the admin review queue. captureMap is stringified
 * for the AWSJSON column. Returns the count written.
 *
 * Skips rules that duplicate an already-active rule in `existing` (#575)
 * so the ruleset stops accumulating identical rows.
 */
async function writeProposedRules(
  client: LinguisticDataClient,
  rules: ProposedRule[],
  fallbackType: string,
  promptVersion: number,
  existing: readonly RuleSummary[],
): Promise<number> {
  const fresh = filterNewProposedRules(rules, existing);
  const skipped = rules.length - fresh.length;
  if (skipped > 0) {
    console.info('linguistic: skipped duplicate AI-proposed rules (#575)', { skipped });
  }
  let written = 0;
  for (const r of fresh) {
    const confidence = typeof r.confidence === 'number' ? r.confidence : AI_RULE_DEFAULT_CONFIDENCE;
    try {
      const res = await client.models.LinguisticRule.create({
        pattern: r.pattern,
        messageType: r.messageType ?? fallbackType,
        component: r.component,
        ...(r.appliesToType ? { appliesToType: r.appliesToType } : {}),
        captureMap: JSON.stringify(r.captureMap ?? {}),
        priority: AI_RULE_PRIORITY,
        enabled: confidence >= RULE_AUTO_ACTIVATE_BAR,
        confidence,
        promptVersion,
        notes: 'AI-generated (#544)',
      });
      if (res.errors) {
        console.warn('linguistic: LinguisticRule.create errored', { errors: res.errors });
      } else {
        written += 1;
      }
    } catch (err) {
      console.warn('linguistic: proposed-rule write failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return written;
}
/** Provider for the Bedrock AI-fallback attempt log (#63/#64). */
const BEDROCK_PROVIDER: LinguisticProvider = 'bedrock';

/** Resolve the Bedrock fallback (injected in tests, real call in prod). */
function bedrockFallback(transcript: string, opts?: FallbackOpts): Promise<FallbackResult | null> {
  return (injected.bedrockFallback ?? tryBedrockFallback)(transcript, opts);
}

/** Resolve the AuditLog writer (injected in tests, real helper in prod). */
function auditFn(ctx: AuditContext, opts: AuditOptions): Promise<string> {
  return (injected.audit ?? defaultAudit)(ctx, opts);
}

/** Resolve the reputation recompute (injected in tests, real helper in prod). */
function repRecomputeFn(client: ReputationHelperClient, userId: string): Promise<number> {
  return (injected.repRecompute ?? recomputeReputation)(client, userId);
}

/**
 * Resolve the deep-debug trace writer (#744). Injected in tests; the
 * default builds + size-guards + writes the LinguisticTrace row
 * best-effort (persistTrace never throws).
 *
 * The size-guard SPILL is wired (#749): oversized traces move their two
 * large text fields to `<DIAGNOSTICS_BUCKET_NAME>/diagnostics/*` and record
 * the keys in `overflowKeys`. `makeDiagnosticsPutObject` returns undefined
 * when the bucket env is unset, in which case the guard falls back to
 * dropping the fields (`truncated=true`). The ~99% of traces under the
 * limit keep everything inline regardless.
 */
function traceWriterFn(client: LinguisticDataClient, input: TraceInput): Promise<void> {
  if (injected.traceWriter) return injected.traceWriter(input);
  const bucket = process.env.DIAGNOSTICS_BUCKET_NAME;
  return persistTrace(client, input, {
    now: nowDate,
    bucket,
    putObject: makeDiagnosticsPutObject(bucket),
  });
}

/** The backend a low-confidence whisper transcript escalates to (#588). */
const ESCALATION_BACKEND = 'amazon-transcribe';
/** Only a whisper transcript triggers escalation (never escalate Transcribe). */
const ESCALATION_SOURCE_BACKEND = 'whisper-local';

/**
 * Low-confidence escalation threshold (#588). A whisper transcript whose
 * overall `transcriptionConfidence` falls BELOW this routes to Amazon
 * Transcribe for a second independent ASR pass. Admin-tunable via the
 * `WHISPER_ESCALATION_THRESHOLD` LinguisticConfig row (value = a number in
 * [0,1]); falls back to the `WHISPER_ESCALATION_THRESHOLD` env var, then
 * the hard-coded default.
 */
const ESCALATION_THRESHOLD_KEY = 'WHISPER_ESCALATION_THRESHOLD';
const DEFAULT_ESCALATION_THRESHOLD = 0.6;

let cachedSqs: SQSClient | undefined;
function sqsClient(): SQSClient {
  return (cachedSqs ??= new SQSClient({}));
}

/**
 * Default {@link EscalateFn}. Publishes the escalation message onto the
 * transcribe queue (`TRANSCRIBE_QUEUE_URL`, wired in `backend.ts` against
 * `pipelineQueues.transcribe.main`). A missing URL warns + no-ops rather
 * than throwing — escalation is best-effort and must never sink the
 * current whisper publish.
 */
async function defaultEscalate(msg: TranscribeEscalationMessage): Promise<void> {
  const queueUrl = process.env.TRANSCRIBE_QUEUE_URL;
  if (!queueUrl) {
    console.warn('linguistic: TRANSCRIBE_QUEUE_URL unset — escalation skipped', {
      recordingId: msg.recordingId,
    });
    return;
  }
  await sqsClient().send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(msg) }),
  );
}

/** Resolve the escalation re-enqueue (injected in tests, SQS in prod). */
function escalateFn(msg: TranscribeEscalationMessage): Promise<void> {
  return (injected.escalate ?? defaultEscalate)(msg);
}

/**
 * Resolve the admin-tunable escalation threshold (#588). Reads the
 * `WHISPER_ESCALATION_THRESHOLD` LinguisticConfig row (value = a number in
 * [0,1]); any miss / out-of-range value falls back to the
 * `WHISPER_ESCALATION_THRESHOLD` env var, then the hard-coded default —
 * so a fresh env with no config row still escalates sensibly.
 */
async function loadEscalationThreshold(client: LinguisticDataClient): Promise<number> {
  const envValue = Number.parseFloat(process.env.WHISPER_ESCALATION_THRESHOLD ?? '');
  const fallback =
    Number.isFinite(envValue) && envValue >= 0 && envValue <= 1
      ? envValue
      : DEFAULT_ESCALATION_THRESHOLD;
  try {
    const res = await client.models.LinguisticConfig.get({ key: ESCALATION_THRESHOLD_KEY });
    if (res.errors || !res.data) return fallback;
    let value: unknown = res.data.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return fallback;
      }
    }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      return value;
    }
    return fallback;
  } catch (err) {
    console.warn('linguistic: escalation-threshold load failed; using fallback', {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

/**
 * Decide + perform a low-confidence escalation to Amazon Transcribe (#588).
 *
 * Fire-and-forget: this NEVER throws into the caller — a failed escalation
 * must not sink the current (whisper) publish (#556 supersede updates the
 * same Message when the second transcript returns). Escalate ONCE; the
 * loop guards (all must pass) are:
 *   - the arriving transcript is from whisper (never escalate a Transcribe
 *     result → no whisper↔transcribe bounce);
 *   - this whisper transcript's confidence is BELOW the threshold;
 *   - the Recording carries source media (`originalKey`) to re-transcribe;
 *   - the `transcripts` collection has NO `amazon-transcribe` entry yet;
 *   - the Recording has no `escalatedAt` marker.
 *
 * Returns the ISO timestamp to persist as `escalatedAt` when an escalation
 * was enqueued, else `null` (caller writes the marker in the same
 * Recording.update that links the Message, so the guard sticks).
 */
async function maybeEscalate(opts: {
  recordingId: string;
  backend: string;
  transcriptionConfidence: number | null | undefined;
  threshold: number;
  originalKey: string | null | undefined;
  alreadyEscalatedAt: string | null | undefined;
  transcripts: { backend: string }[];
  ts: string;
}): Promise<string | null> {
  // Guard 1: only a whisper transcript triggers escalation.
  if (opts.backend !== ESCALATION_SOURCE_BACKEND) return null;
  // Guard 2: confidence must be a number BELOW the threshold. An absent
  // confidence is NOT escalated — we can't claim it's low.
  const conf = opts.transcriptionConfidence;
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf >= opts.threshold) return null;
  // Guard 3: already escalated (marker) → never again.
  if (opts.alreadyEscalatedAt) return null;
  // Guard 4: a Transcribe transcript already exists → never again.
  if (opts.transcripts.some((t) => t.backend === ESCALATION_BACKEND)) return null;
  // Guard 5: need source media to re-transcribe.
  const originalKey = typeof opts.originalKey === 'string' ? opts.originalKey : '';
  if (!originalKey) {
    console.warn('linguistic: low-confidence whisper but no originalKey — cannot escalate', {
      recordingId: opts.recordingId,
    });
    return null;
  }

  try {
    await escalateFn({
      recordingId: opts.recordingId,
      originalKey,
      enqueuedAt: opts.ts,
      backendOverride: ESCALATION_BACKEND,
    });
    console.info('linguistic: escalated low-confidence whisper to Amazon Transcribe', {
      recordingId: opts.recordingId,
      transcriptionConfidence: conf,
      threshold: opts.threshold,
    });
    return opts.ts;
  } catch (err) {
    // Best-effort — log + continue. The whisper Message still publishes;
    // an operator can redrive the escalation manually (admin reprocess).
    console.error('linguistic: escalation enqueue failed (whisper publish unaffected)', {
      recordingId: opts.recordingId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Prefix of the `deletedReason` a supersede soft-delete writes (#556).
 * The re-link recovery (#599) gates on this: ONLY a Message the pipeline
 * itself superseded is auto-recovered — an admin-intentional delete (any
 * other reason) stays deleted. Shared so the writer + the gate can't drift.
 */
const SUPERSEDE_REASON_PREFIX = 'Superseded by re-run';

/**
 * Supersede the prior Message (M_old) on a re-run that produced a
 * genuinely different parse (#556 revised semantics).
 *
 * A re-run does NOT mutate M_old in place — it creates/links a FRESH
 * Message via the normal dedup path, then this routine soft-deletes the
 * now-orphaned M_old, but ONLY when removing it is safe:
 *
 *   - M_old must differ from the new target (an identical re-parse keeps
 *     the same deterministic id and never reaches here).
 *   - M_old must be a pipeline-created message — `submitterId` unset.
 *     A recording-less / manual submission is never auto-deleted.
 *   - This Recording must be M_old's ONLY (non-deleted) Recording. If
 *     other SDR captures still point at M_old (multi-SDR), it stays.
 *
 * Best-effort: a soft-delete or audit hiccup must never sink the
 * transcript — the fresh Message is already published.
 */
async function supersedePriorMessage(
  client: LinguisticDataClient,
  priorMessageId: string,
  newMessageId: string,
  recordingId: string,
): Promise<void> {
  if (!priorMessageId || priorMessageId === newMessageId) return;
  try {
    const old = await client.models.Message.get({ id: priorMessageId });
    const oldRow = old.data;
    // Already gone, or query miss → nothing to supersede.
    if (!oldRow || oldRow.deletedAt) return;
    // Recording-less / manual submission → never auto-delete (#556).
    if (oldRow.submitterId) {
      console.info('linguistic: prior Message is recording-less; not superseding', {
        recordingId,
        priorMessageId,
      });
      return;
    }
    // Count M_old's remaining live Recordings. By the time this runs the
    // caller has ALREADY repointed this Recording's `messageId` to the new
    // target, so the single-audio case returns 0 here (this Recording moved
    // off M_old) and a multi-SDR case returns the still-attached siblings —
    // hence `length === 0` is the primary "M_old was audio-only" path, not
    // dead code. The GSI is eventually consistent: a sibling SDR capture
    // that linked to M_old microseconds ago might not appear, so this could
    // soft-delete an M_old that just gained a sibling. Accepted: the window
    // is tiny, only on an admin-triggered re-run, the delete is a reversible
    // soft-delete (restorable), and the stranded sibling re-dedups on its
    // next write. (A GSI cannot be read strongly-consistent, so a
    // ConsistentRead fix is not available.)
    const siblings = await client.models.Recording.listRecordingByMessageId({
      messageId: priorMessageId,
    });
    const live = (siblings.data ?? []).filter((r) => !r.deletedAt);
    const onlyThisOne = live.length === 0 || live.every((r) => r.id === recordingId);
    if (!onlyThisOne) {
      console.info('linguistic: prior Message has other Recordings; not superseding', {
        recordingId,
        priorMessageId,
        liveRecordings: live.length,
      });
      return;
    }

    const ts = nowDate().toISOString();
    const deleted = await client.models.Message.update({
      id: priorMessageId,
      deletedAt: ts,
      deletedReason: `${SUPERSEDE_REASON_PREFIX} of Recording ${recordingId} (#556)`,
    });
    if (deleted.errors) {
      console.warn('linguistic: failed to soft-delete superseded Message', {
        recordingId,
        priorMessageId,
        errors: deleted.errors,
      });
      return;
    }
    try {
      await auditFn(
        { identity: null, request: { headers: {} } },
        {
          action: 'MESSAGE_DELETE',
          targetType: 'Message',
          targetId: priorMessageId,
          before: { id: priorMessageId, deletedAt: null },
          after: { id: priorMessageId, deletedAt: ts },
          reason: `Superseded by re-run of Recording ${recordingId} (new Message ${newMessageId})`,
        },
      );
    } catch (err) {
      console.error('linguistic: supersede audit write failed (delete still applied)', {
        recordingId,
        priorMessageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    console.info('linguistic: superseded prior Message on re-run', {
      recordingId,
      priorMessageId,
      newMessageId,
    });
  } catch (err) {
    console.error('linguistic: supersede check failed (transcript still published)', {
      recordingId,
      priorMessageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Recover a soft-deleted Message that a re-run deterministically re-maps
 * onto (#599). The dedup `Message.list` excludes soft-deleted rows, so the
 * ONLY way a re-run links to a deleted Message is the deterministic-id
 * create collision: an earlier divergent re-run superseded M (#556), and a
 * later re-run whose parse returns to the original recomputes the same id.
 * Without this the Recording would link to a still-`deletedAt` Message and
 * the entry would stay hidden.
 *
 * Gated to supersede-caused deletes only: a Message whose `deletedReason`
 * was NOT written by supersede (i.e. an admin-intentional delete) stays
 * deleted — a re-run must never resurrect it against admin intent.
 *
 * Clears `deletedAt` / `deletedBy` / `deletedReason`, re-publishes
 * (`publishedAt = now`), and writes a `MESSAGE_RESTORE` AuditLog entry
 * (mirrors the supersede `MESSAGE_DELETE`). No-op when the Message is
 * already live or was admin-deleted. Best-effort: a recovery or audit
 * hiccup must never sink the publish — the Recording link is committed by
 * the caller regardless.
 */
async function recoverIfDeleted(
  client: LinguisticDataClient,
  messageId: string,
  recordingId: string,
  ts: string,
): Promise<void> {
  try {
    const existing = await client.models.Message.get({ id: messageId });
    const row = existing.data;
    // Missing (query miss) or already live → nothing to recover.
    if (!row || !row.deletedAt) return;
    // Only auto-recover a Message the pipeline itself superseded (#556).
    // An admin-intentional delete (any other reason, or no reason) must
    // stay deleted — a re-run must not resurrect it against admin intent.
    if (!row.deletedReason?.startsWith(SUPERSEDE_REASON_PREFIX)) {
      console.info('linguistic: colliding Message deleted by an admin; leaving deleted', {
        recordingId,
        messageId,
      });
      return;
    }
    const prevDeletedAt = row.deletedAt;
    const recovered = await client.models.Message.update({
      id: messageId,
      deletedAt: null,
      deletedBy: null,
      deletedReason: null,
      publishedAt: ts,
    });
    if (recovered.errors) {
      console.warn('linguistic: failed to recover soft-deleted Message on re-link', {
        recordingId,
        messageId,
        errors: recovered.errors,
      });
      return;
    }
    try {
      await auditFn(
        { identity: null, request: { headers: {} } },
        {
          action: 'MESSAGE_RESTORE',
          targetType: 'Message',
          targetId: messageId,
          before: { id: messageId, deletedAt: prevDeletedAt },
          after: { id: messageId, deletedAt: null },
          reason: `Recovered on re-run of Recording ${recordingId} (parse re-mapped to this Message) (#599)`,
        },
      );
    } catch (err) {
      console.error('linguistic: recovery audit write failed (recover still applied)', {
        recordingId,
        messageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    console.info('linguistic: recovered soft-deleted Message on re-link', {
      recordingId,
      messageId,
    });
  } catch (err) {
    console.error('linguistic: recovery check failed (transcript still published)', {
      recordingId,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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

/** Logical promptId for the Bedrock parse prompt (one active version). */
const BEDROCK_PARSE_PROMPT_ID = 'linguistic-parse-bedrock';

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
      // Active is per-promptId — scope to the Bedrock parse prompt so a
      // future second promptId (e.g. rule generation) can't be picked up.
      filter: { promptId: { eq: BEDROCK_PARSE_PROMPT_ID }, isActive: { eq: true } },
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

/**
 * Whether a parse carries fields supplied by an AI-generated rule or a
 * Bedrock parse. The hard-coded inline `classify()` returns the message
 * TYPE only (never fields), so a type-only result has none. This is the
 * rules→AI gate (#552): if no field-bearing rule produced the parse, the
 * transcript routes to Bedrock for field extraction + type re-verification.
 */
function hasCapturedFields(result: ClassifyResult): boolean {
  const f = result.fields;
  return !!f && Boolean(f.sender || f.receiver || f.body);
}

interface RawLinguisticMessage {
  kind?: 'transcript' | 'transcribe-failure';
  recordingId?: string;
  transcript?: string;
  backend?: string;
  wordTimestampsKey?: string;
  webCanonicalKey?: string;
  canonicalSizeBytes?: number;
  transcriptionConfidence?: number;
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
    // Default legacy/in-flight messages (no `backend`) to whisper-local —
    // the sole historical transcript producer (#593).
    backend:
      typeof parsed.backend === 'string' && parsed.backend.length > 0
        ? parsed.backend
        : 'whisper-local',
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
    // Overall whisper confidence (#581). Validate it's a finite number in
    // [0,1] — drop anything else (a bad/legacy value must never persist a
    // bogus score on the Recording).
    transcriptionConfidence:
      typeof parsed.transcriptionConfidence === 'number' &&
      Number.isFinite(parsed.transcriptionConfidence) &&
      parsed.transcriptionConfidence >= 0 &&
      parsed.transcriptionConfidence <= 1
        ? parsed.transcriptionConfidence
        : undefined,
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

  // #741: a recording that has already reached a terminal state must not be
  // re-parsed or regressed by a stray / duplicate SQS delivery (standard
  // queues are at-least-once). Skip the whole transcript path — no PARSING
  // write, no re-parse, no terminal re-write — so a finished recording
  // stays put (and we don't burn a redundant Bedrock call). Admin reprocess
  // resets the row to QUEUED first, so legitimate re-runs are not blocked.
  if (isTerminalRecordingStatus(rec.data?.transcriptionStatus)) {
    console.info('linguistic: skipped — recording already terminal (#741)', {
      recordingId: msg.recordingId,
      status: rec.data?.transcriptionStatus,
    });
    return;
  }

  // Advance → PARSING while the transcript is classified, so the My Uploads
  // badge reflects this step (#433 status ladder). Best-effort: the
  // authoritative terminal write (PUBLISHED / PARSE_FAILED) happens below,
  // so a failure here is cosmetic — log rather than throw.
  const parsingUpdate = await client.models.Recording.update({
    id: msg.recordingId,
    transcriptionStatus: 'PARSING',
    transcriptionStatusUpdatedAt: nowDate().toISOString(),
  });
  if (parsingUpdate.errors) {
    console.warn('linguistic: failed to mark Recording PARSING (continuing)', {
      recordingId: msg.recordingId,
      errors: parsingUpdate.errors,
    });
  }
  // Stable broadcast time (#556): persisted on the FIRST pipeline run and
  // reused on every re-run, so the deterministic id + dedup window don't
  // shift when a testing-portal re-run carries a fresh `enqueuedAt`. When
  // absent we fall back to `enqueuedAt` AND persist it below, so the next
  // run reads the same value and an identical re-parse stays idempotent.
  const persistedBroadcastedAt = rec.data?.broadcastedAt ?? null;
  const broadcastTime = persistedBroadcastedAt ?? msg.enqueuedAt;
  // The Message this Recording pointed at before this run (M_old). On a
  // re-run that produces a different parse we supersede it (#556).
  const priorMessageId = rec.data?.messageId ?? null;
  const existingAttempts = coerceAttempts(rec.data?.linguisticAttempts);

  // Multi-transcript collection (#593): UPSERT this backend's transcript
  // into the Recording's `transcripts` (keyed by backend, leaving the
  // other backends' entries intact), then pick the primary/active one.
  // The primary mirrors the top-level `transcript`/`transcriptionConfidence`
  // for back-compat with every existing reader. A single-whisper recording
  // yields exactly one entry → primary === this transcript, so the default
  // path is unchanged.
  const backend = msg.backend ?? 'whisper-local';
  const nowTs = nowDate().toISOString();
  const existingTranscripts = coerceTranscripts(rec.data?.transcripts);
  const transcriptsCollection = upsertTranscript(existingTranscripts, {
    backend,
    transcript: msg.transcript,
    transcriptionConfidence:
      typeof msg.transcriptionConfidence === 'number' ? msg.transcriptionConfidence : null,
    ...(msg.wordTimestampsKey ? { wordTimestampsKey: msg.wordTimestampsKey } : {}),
    ts: nowTs,
  });
  const primary = selectPrimary(transcriptsCollection) ?? {
    backend,
    transcript: msg.transcript,
    transcriptionConfidence:
      typeof msg.transcriptionConfidence === 'number' ? msg.transcriptionConfidence : null,
    ts: nowTs,
  };
  // The parse runs over the PRIMARY (best) transcript; when >1 backend is
  // present the Bedrock fallback additionally reconciles across all of them.
  const parseTranscript = primary.transcript;

  // Low-confidence escalation (#588 / epic #582). A whisper transcript that
  // came back BELOW the admin-tunable threshold is escalated ONCE to Amazon
  // Transcribe for a second independent ASR pass; the reconciled re-parse
  // updates the SAME Message later (#556 supersede), so we do NOT block the
  // current whisper publish on it. `maybeEscalate` owns every loop guard +
  // is fire-and-forget (never throws). It returns the timestamp to persist
  // as the `escalatedAt` loop-guard marker (or null when it didn't escalate).
  // NOTE: we read the threshold + decide BEFORE the (slow) parse so a failed
  // escalation enqueue can't be masked by a later parse error.
  const escalationThreshold = await loadEscalationThreshold(client);
  const escalatedAt = await maybeEscalate({
    recordingId: msg.recordingId,
    backend,
    transcriptionConfidence:
      typeof msg.transcriptionConfidence === 'number' ? msg.transcriptionConfidence : null,
    threshold: escalationThreshold,
    originalKey: rec.data?.originalKey,
    alreadyEscalatedAt: rec.data?.escalatedAt,
    transcripts: existingTranscripts,
    ts: nowTs,
  });

  const engine = rulesEngine();
  let result = await classifyWithRules(parseTranscript, engine);

  // Deep-debug trace capture (#744). Best-effort throughout — the trace is
  // diagnostic, so a capture hiccup must never affect the parse. Re-runs the
  // engine's traced match to record every rule evaluation (cached rules; one
  // extra regex pass, negligible next to a Bedrock call).
  let traceRuleEvaluations: unknown = [];
  let traceRulesOutcome: unknown = null;
  let traceBedrock: TraceBedrock | null = null;
  try {
    const traced = await engine.tryMatchTraced?.(parseTranscript);
    if (traced) {
      traceRuleEvaluations = traced.evaluations;
      traceRulesOutcome = traced.match;
    }
  } catch (err) {
    console.warn('linguistic: traced rules capture failed (trace only, non-fatal)', {
      recordingId: msg.recordingId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Attempt provenance — rules path by default; switched to bedrock below.
  let attemptProvider: LinguisticProvider = RULES_PROVIDER;
  let attemptPromptVersion: number | null = result.promptVersion ?? null;
  let attemptPromptHash: string | null = null;
  let attemptSuccess = true;

  // Bedrock AI fallback (#63/#552) — runs whenever no field-bearing rule
  // supplied the parse. The hard-coded inline `classify()` yields the
  // message TYPE only, so a type-only result always routes to Bedrock,
  // regardless of its type-confidence: Bedrock extracts the fields AND
  // re-verifies the type (the inline guess can be wrong), then emits
  // per-component rules so future similar transcripts match a rule and
  // skip the AI. A DDB rule that captured fields short-circuits this. At
  // a 0-rule launch everything routes to the AI (self-improving loop).
  if (!hasCapturedFields(result)) {
    // Resolve the admin-editable prompt (active DB template, else the
    // git-reviewed markdown default) and thread it through both the hash
    // (for the attempt skip key) and the model call.
    const tmpl = await loadActivePromptTemplate(client);
    // Pass ALL of the Recording's transcripts (labelled by backend +
    // confidence) to the fallback (#593). When >1, the rendered prompt
    // gains the "Multiple transcripts — reconcile" section and the model
    // reads across the independent ASR sources. With a single transcript
    // this is a one-element list → no reconcile section → byte-identical
    // single-source prompt + hash, so the default path is unchanged.
    const reconcileTranscripts: TranscriptForReconcile[] = transcriptsCollection.map((t) => ({
      backend: t.backend,
      transcript: t.transcript,
      transcriptionConfidence: t.transcriptionConfidence ?? null,
    }));
    const fbOpts: FallbackOpts = {
      ...(tmpl.body ? { promptTemplate: tmpl.body } : {}),
      ...(typeof tmpl.version === 'number' ? { promptVersion: tmpl.version } : {}),
      transcripts: reconcileTranscripts,
    };
    const {
      rendered,
      promptVersion: bedrockVersion,
      modelId,
    } = renderFallbackPrompt(parseTranscript, fbOpts);
    attemptProvider = BEDROCK_PROVIDER;
    attemptPromptVersion = bedrockVersion;
    // Hash the BASE rendered prompt (template + transcript) only — the
    // refine context below is dynamic and must not bust the skip key.
    attemptPromptHash = hashPrompt(rendered);
    // Feed the failed attempt + current ruleset so the model refines
    // existing rules rather than only generating fresh ones (#544b). The
    // ruleset summary is best-effort — a loader hiccup must not sink the
    // transcript, so fall back to no ruleset context.
    let summaries: RuleSummary[] = [];
    try {
      summaries = (await engine.snapshot?.()) ?? [];
    } catch (err) {
      console.warn('linguistic: ruleset snapshot failed; AI context omits it', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // Known-callsign priming (#778) — best-effort; a dictionary hiccup just
    // omits the callsign list from the context.
    let knownCallsigns: string[] = [];
    try {
      knownCallsigns = await loadApprovedCallsigns(client);
    } catch (err) {
      console.warn('linguistic: callsign load failed; AI context omits it', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    fbOpts.context = buildBedrockContext(result, summaries, knownCallsigns);
    // Always invoke on the fallback path. We deliberately do NOT skip the
    // call when a prior bedrock success is logged: the attempt log stores
    // only the result *hash*, not the parsed type/fields, so a skip would
    // leave `result` as OTHER and the dedup below would create a SECOND
    // (OTHER-typed) Message instead of linking to the prior bedrock-typed
    // one. The deterministic-id dedup already makes a redrive idempotent
    // (same parse → same id → link); re-invoking on a rare redrive is the
    // safe trade. A cost-skip that reuses the stored parse is a follow-up.
    const fb = await bedrockFallback(parseTranscript, fbOpts);
    // Deep-debug trace (#744): capture the full Bedrock request/response.
    // `fb.diagnostics` carries the exact prompt sent + raw Converse output;
    // when `fb` is null (Bedrock gave nothing usable) fall back to the
    // rendered prompt we computed for the hash so the trace still shows what
    // was sent.
    traceBedrock = {
      modelId,
      promptVersion: bedrockVersion,
      promptHash: attemptPromptHash,
      renderedPrompt: fb?.diagnostics?.renderedPrompt ?? rendered,
      rawResponse: fb?.diagnostics?.rawResponse ?? null,
      parsed: fb
        ? {
            type: fb.message.type,
            sender: fb.message.sender ?? null,
            receiver: fb.message.receiver ?? null,
            body: fb.message.body ?? null,
            confidence: fb.message.confidence,
            retried: fb.retried,
          }
        : null,
      proposedRules: fb?.rules ?? [],
    };
    // Log the raw Bedrock parse for debugging (#560) — the attempt log
    // stores only hashes, so without this the model's actual output
    // (body, fields, proposed rules) is invisible in CloudWatch.
    console.info('linguistic: bedrock parse', {
      recordingId: msg.recordingId,
      modelId,
      parsed: fb
        ? {
            type: fb.message.type,
            confidence: fb.message.confidence,
            sender: fb.message.sender ?? null,
            receiver: fb.message.receiver ?? null,
            body: fb.message.body ?? null,
          }
        : null,
      rules: fb
        ? fb.rules.map((r) => ({
            component: r.component,
            appliesToType: r.appliesToType ?? null,
            confidence: r.confidence ?? null,
            pattern: r.pattern,
          }))
        : [],
    });
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
      // Self-improving loop (#544): persist the model's proposed rules so
      // future similar transcripts match a rule and skip the AI. Only on
      // a fresh parse (no prior bedrock attempt) to avoid duplicating
      // rules on an SQS redrive.
      const alreadyTried = existingAttempts.some((a) => a.provider === BEDROCK_PROVIDER);
      if (fb.rules.length > 0 && !alreadyTried) {
        const n = await writeProposedRules(
          client,
          fb.rules,
          result.type,
          bedrockVersion,
          summaries,
        );
        if (n > 0) {
          console.info('linguistic: wrote AI-proposed rules', {
            recordingId: msg.recordingId,
            count: n,
          });
        }
      }
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
    transcript: parseTranscript,
    ...(result.fields?.sender ? { sender: result.fields.sender } : {}),
    ...(result.fields?.receiver ? { receiver: result.fields.receiver } : {}),
    ...(result.fields?.body ? { body: result.fields.body } : {}),
  });
  // `||` not `??`: decodePhonetic returns "" for a body with no
  // decodable letters — fall back to the primary transcript.
  const canonical = normalized.body || parseTranscript;
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

  // True only when THIS run created a brand-new Message (not a dedup link
  // / race collision). Gates the PARSE_FAILED status below so a Recording
  // that links to an existing GOOD Message is never marked failed (#579).
  let createdFresh = false;
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
      // Force-flag when the AI parse failed and we fell back to the inline
      // type-only classifier (#579): the fields are unreliable (raw body, no
      // sender), so the Message must never sit as "clean".
      flaggedForReview:
        !attemptSuccess ||
        isFlagged({ type: result.type, confidence: result.confidence }, confidenceConfig),
      publishedAt: ts,
    });
    if (created.errors) {
      if (isConditionalCheckError(created.errors)) {
        // A Message with this deterministic id already exists — either a
        // concurrent identical capture won the race, OR this is a re-run
        // re-mapping onto a Message a prior divergent re-run superseded
        // (#556). Link to it; if it is soft-deleted, recover it (#599) so
        // the Recording never points at a hidden Message.
        targetMessageId = messageId;
        console.info('linguistic: dedup create collided, linking to existing', {
          recordingId: msg.recordingId,
          messageId,
        });
        await recoverIfDeleted(client, messageId, msg.recordingId, ts);
      } else {
        throw new Error(
          `linguistic: Message.create returned errors: ${JSON.stringify(created.errors)}`,
        );
      }
    } else {
      targetMessageId = created.data?.id ?? messageId;
      createdFresh = true;
    }
  }

  // Link the Recording → Message + advance status in one update. A Message
  // is always published (the inline fallback still yields a typed row), but
  // when the AI parse failed on a fresh create (#579) the Recording lands
  // PARSE_FAILED — the flagged Message is linked for review/re-run, not
  // presented as clean. `transcriptionFailed` mirrors the markFailed()
  // contract so the manual-transcript gate (transcriptRevisionMutations)
  // treats it like any other failed parse; cleared on a successful publish
  // so a recovering re-run resets it.
  const aiParseFailed = !attemptSuccess && createdFresh;
  // Primary transcript fields the top-level columns mirror for back-compat
  // (#593). `primary` is the highest-confidence entry across all backends;
  // for a single-whisper recording it IS this transcript, so these writes
  // are identical to the pre-#593 behaviour.
  //
  // Word timestamps are ASR-backend-SPECIFIC (whisper token offsets vs
  // Amazon Transcribe item times), so the top-level `wordTimestampsKey`
  // MUST come from the primary's OWN entry — never fall back to the
  // just-arrived `msg` when the primary is a different backend, or the
  // primary transcript text would be paired with the wrong backend's
  // timestamps (scrub-to-text mismatch). Each transcripts[] entry carries
  // its own key; the whisper entry's key is populated from
  // `msg.wordTimestampsKey` at UPSERT time above, so the single-whisper
  // default path still surfaces it.
  const primaryWordTimestampsKey = primary.wordTimestampsKey ?? undefined;
  const updated = await client.models.Recording.update({
    id: msg.recordingId,
    messageId: targetMessageId,
    transcript: primary.transcript,
    // Per-backend transcript collection (#593), stringified for AWSJSON.
    transcripts: JSON.stringify(transcriptsCollection),
    transcriptionStatus: aiParseFailed ? 'PARSE_FAILED' : 'PUBLISHED',
    transcriptionFailed: aiParseFailed,
    failedReason: aiParseFailed
      ? 'AI parse failed; inline fallback published + flagged for review (#579)'
      : null,
    transcriptionStatusUpdatedAt: ts,
    // Persist a stable broadcast time on the FIRST run only (#556), so
    // every subsequent re-run reuses it and an unchanged re-parse maps to
    // the same deterministic Message id (no churn).
    ...(persistedBroadcastedAt ? {} : { broadcastedAt: broadcastTime }),
    // Persist the appended attempt log (#64). Stringified for AWSJSON.
    linguisticAttempts: JSON.stringify(attempts),
    ...(primaryWordTimestampsKey ? { wordTimestampsKey: primaryWordTimestampsKey } : {}),
    // Web-canonical Opus produced by the Whisper container (#514).
    ...(msg.webCanonicalKey ? { webCanonicalKey: msg.webCanonicalKey } : {}),
    ...(typeof msg.canonicalSizeBytes === 'number'
      ? { canonicalSizeBytes: msg.canonicalSizeBytes }
      : {}),
    // Overall transcription confidence (#581/#593) — mirror the PRIMARY
    // transcript's confidence (best across backends). Distinct from
    // Message.confidence (parse). Only when the primary carries a value.
    ...(typeof primary.transcriptionConfidence === 'number'
      ? { transcriptionConfidence: primary.transcriptionConfidence }
      : {}),
    // Low-confidence escalation marker (#588) — set only when this run
    // enqueued an Amazon Transcribe escalation, so the next pass's loop
    // guard sees it and never re-escalates.
    ...(escalatedAt ? { escalatedAt } : {}),
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

  // Deep-debug trace (#744). Written best-effort AFTER the authoritative
  // Recording update so a trace failure can never block the publish or the
  // 30-minute SLA (persistTrace swallows internally; the extra guard here
  // covers an injected test writer that throws).
  try {
    await traceWriterFn(client, {
      recordingId: msg.recordingId,
      runAt: ts,
      triggerBackend: backend,
      transcriptSnapshot: parseTranscript,
      rulesEvaluated: traceRuleEvaluations,
      rulesOutcome: traceRulesOutcome,
      bedrock: traceBedrock,
      finalResult: {
        type: result.type,
        sender: normalized.sender ?? null,
        receiver: normalized.receiver ?? null,
        body: canonical,
        confidence: result.confidence,
        source: attemptProvider,
      },
      attemptSuccess,
      resultHash,
      promptHash: attemptPromptHash,
    });
  } catch (err) {
    console.warn('linguistic: trace write failed (non-fatal)', {
      recordingId: msg.recordingId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Callsign suggestion (#776). Any parsed sender/receiver not already in the
  // dictionary lands as an AI_SUGGESTED/approved=false row for admin
  // confirm/reject (#777). Best-effort AFTER the authoritative update — a
  // dictionary write must never block publish. Skip on the failed-parse
  // branch (fields unreliable).
  if (!aiParseFailed) {
    try {
      const candidates = callsignCandidates(normalized.sender, normalized.receiver);
      const created = await suggestCallsigns(client, candidates);
      if (created.length > 0) {
        console.info('linguistic: suggested callsigns', {
          recordingId: msg.recordingId,
          created,
        });
        for (const normalizedCallsign of created) {
          try {
            await auditFn(
              { identity: null, request: { headers: {} } },
              {
                action: 'CALLSIGN_SUGGEST',
                targetType: 'Callsign',
                targetId: normalizedCallsign,
                after: { normalized: normalizedCallsign, source: 'AI_SUGGESTED', approved: false },
                reason: `auto-suggested from recording ${msg.recordingId}`,
              },
            );
          } catch {
            // Audit is non-fatal; the suggestion already landed.
          }
        }
      }
    } catch (err) {
      console.warn('linguistic: callsign suggestion failed (non-fatal)', {
        recordingId: msg.recordingId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Reputation recompute on publish (#480). A PUBLISHED recording is a
  // validated submission for its uploader. Best-effort + inline (not a DDB
  // stream, which would close a data-stack CFN cycle — #658/#661). Skips
  // the PARSE_FAILED branch. uploaderId comes from the update's returned
  // row (Amplify returns the full item).
  if (!aiParseFailed) {
    const uploaderId = (updated.data as { uploaderId?: string | null } | null)?.uploaderId;
    if (uploaderId) {
      try {
        await repRecomputeFn(client as unknown as ReputationHelperClient, uploaderId);
      } catch (err) {
        console.error('linguistic: reputation recompute failed (non-fatal)', {
          recordingId: msg.recordingId,
          uploaderId,
          err,
        });
      }
    }
  }

  // Re-run supersede (#556): the Recording now points at the fresh
  // Message. If it previously pointed at a DIFFERENT pipeline-created
  // Message that this Recording was the sole owner of, soft-delete that
  // orphaned M_old. Runs only after the link succeeds so we never delete
  // a Message the Recording still references. Best-effort inside.
  if (priorMessageId && targetMessageId && priorMessageId !== targetMessageId) {
    await supersedePriorMessage(client, priorMessageId, targetMessageId, msg.recordingId);
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
