import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { normalizeParsed } from './normalize';

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
}

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
    };
    Recording: {
      update: (input: {
        id: string;
        messageId?: string | null;
        transcript?: string | null;
        transcriptionStatus?: string;
        transcriptionStatusUpdatedAt?: string;
        transcriptionFailed?: boolean;
        failedReason?: string | null;
        wordTimestampsKey?: string | null;
      }) => Promise<{ data: unknown; errors?: unknown }>;
    };
  };
}

export interface LinguisticDeps {
  dataClient?: LinguisticDataClient;
  now?: () => Date;
  uuid?: () => string;
}

let injected: LinguisticDeps = {};

export function __setDeps(deps: LinguisticDeps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
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

function uuid(): string {
  return (injected.uuid ?? randomUUID)();
}

/**
 * Amplify Data `.update()` is a conditional write gated on
 * `attribute_exists(id)`. When the Recording row was deleted while a
 * pipeline message was still in flight (admin delete during
 * transcription), the update comes back with a
 * `DynamoDB:ConditionalCheckFailedException` in `errors[]`. That is a
 * tombstone signal, not a real failure — the caller should drop the
 * SQS message cleanly instead of throwing + redriving (#459).
 */
function isDeletedRowError(errors: unknown): boolean {
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

interface RawLinguisticMessage {
  kind?: 'transcript' | 'transcribe-failure';
  recordingId?: string;
  transcript?: string;
  wordTimestampsKey?: string;
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
    enqueuedAt: parsed.enqueuedAt ?? nowDate().toISOString(),
  };
}

async function processTranscript(msg: TranscriptQueueMessage): Promise<void> {
  const client = await dataClient();
  const result = classify(msg.transcript);
  // Turn the raw transcript into log-format fields: NATO-decode the
  // body, collapse double broadcasts, extract sender/receiver (#506).
  // The raw transcript stays on the Recording row (source of truth);
  // the Message carries the derived/normalized form.
  const normalized = normalizeParsed({ type: result.type, transcript: msg.transcript });
  const messageId = uuid();
  const ts = nowDate().toISOString();

  const created = await client.models.Message.create({
    id: messageId,
    type: result.type,
    // Stand-in until the pipeline threads a real broadcasted_at
    // through (#433 follow-up). `broadcastTs` is .required() on the
    // Message schema, so we MUST emit it.
    broadcastTs: msg.enqueuedAt,
    body: normalized.body ?? msg.transcript,
    ...(normalized.sender ? { sender: normalized.sender } : {}),
    ...(normalized.receiver ? { receiver: normalized.receiver } : {}),
    confidence: result.confidence,
    flaggedForReview: result.confidence < 0.8,
    publishedAt: ts,
  });
  if (created.errors) {
    throw new Error(
      `linguistic: Message.create returned errors: ${JSON.stringify(created.errors)}`,
    );
  }
  const newMessageId = created.data?.id ?? messageId;

  // Single Recording.update writes transcript + sidecar key +
  // advances state to PUBLISHED in one round-trip; intermediate
  // PARSING state is collapsed since linguistic finishes the work
  // synchronously.
  const updated = await client.models.Recording.update({
    id: msg.recordingId,
    messageId: newMessageId,
    transcript: msg.transcript,
    transcriptionStatus: 'PUBLISHED',
    transcriptionStatusUpdatedAt: ts,
    ...(msg.wordTimestampsKey ? { wordTimestampsKey: msg.wordTimestampsKey } : {}),
  });
  if (updated.errors) {
    if (isDeletedRowError(updated.errors)) {
      // Recording was deleted while this message was in flight. Drop
      // the orphan Message we just created so it never surfaces in the
      // public feed without a Recording, then return cleanly so SQS
      // deletes the message instead of redriving (#459).
      //
      // The delete is best-effort: dropping the SQS message must win
      // over a failed cleanup. If we let a delete error propagate, the
      // handler would mark + rethrow + redrive, and the next attempt
      // would create a *fresh* orphan Message before tombstoning again
      // — an orphan-creation loop. A leaked orphan Message is the
      // lesser evil (and is swept by the future Message janitor, #459
      // out-of-scope).
      let orphanMessageDeleted = false;
      try {
        const deleted = await client.models.Message.delete({ id: newMessageId });
        orphanMessageDeleted = !deleted.errors;
        if (deleted.errors) {
          console.error('linguistic: failed to delete orphan Message', {
            messageId: newMessageId,
            errors: deleted.errors,
          });
        }
      } catch (err) {
        console.error('linguistic: orphan Message delete threw', {
          messageId: newMessageId,
          err: String(err),
        });
      }
      console.warn('linguistic: Recording deleted in flight, dropping transcript message', {
        recordingId: msg.recordingId,
        messageId: newMessageId,
        orphanMessageDeleted,
      });
      return;
    }
    throw new Error(
      `linguistic: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }

  console.info('linguistic: published Message', {
    recordingId: msg.recordingId,
    messageId: newMessageId,
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
    if (isDeletedRowError(updated.errors)) {
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
