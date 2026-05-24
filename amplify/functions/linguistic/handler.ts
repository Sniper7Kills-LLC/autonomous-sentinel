import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

/**
 * Linguistic Lambda (#433 stage 4).
 *
 * Consumes the linguistic SQS queue (populated by the Whisper handler
 * at stage 3). Each message carries
 *   `{ recordingId, transcript, enqueuedAt }`.
 *
 * For each message:
 *   1. Rule-based parser classifies the transcript by keyword to
 *      pick a `Message.type` from the enum.
 *   2. Creates a Message row through the Amplify Data client so
 *      AppSync's subscription publisher fires.
 *   3. Updates the Recording row (Amplify Data client too) so the
 *      portal's `observeQuery` subscription sees the row advance to
 *      `PUBLISHED` with the new `messageId`.
 *
 * Failure path: mark the Recording `PARSE_FAILED` + `failedReason`
 * before rethrowing so SQS redrives + admin/portal see the stuck
 * state.
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

interface LinguisticQueueMessage {
  recordingId: string;
  transcript: string;
  enqueuedAt: string;
}

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
        confidence?: number | null;
        flaggedForReview?: boolean | null;
        publishedAt?: string | null;
      }) => Promise<{ data: { id?: string } | null; errors?: unknown }>;
    };
    Recording: {
      update: (input: {
        id: string;
        messageId?: string | null;
        transcriptionStatus?: string;
        transcriptionStatusUpdatedAt?: string;
        transcriptionFailed?: boolean;
        failedReason?: string | null;
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

export function parseMessage(body: string): LinguisticQueueMessage {
  const parsed = JSON.parse(body) as Partial<LinguisticQueueMessage>;
  if (!parsed.recordingId || typeof parsed.transcript !== 'string') {
    throw new Error(`linguistic: SQS body missing required fields: ${JSON.stringify(parsed)}`);
  }
  return {
    recordingId: parsed.recordingId,
    transcript: parsed.transcript,
    enqueuedAt: parsed.enqueuedAt ?? nowDate().toISOString(),
  };
}

async function processOne(msg: LinguisticQueueMessage): Promise<void> {
  const client = await dataClient();
  const result = classify(msg.transcript);
  const messageId = uuid();
  const ts = nowDate().toISOString();

  const created = await client.models.Message.create({
    id: messageId,
    type: result.type,
    // Stand-in until the pipeline threads a real broadcasted_at
    // through (#433 follow-up). `broadcastTs` is .required() on the
    // Message schema, so we MUST emit it.
    broadcastTs: msg.enqueuedAt,
    body: msg.transcript,
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

  const updated = await client.models.Recording.update({
    id: msg.recordingId,
    messageId: newMessageId,
    transcriptionStatus: 'PUBLISHED',
    transcriptionStatusUpdatedAt: ts,
  });
  if (updated.errors) {
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
      await processOne(msg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('linguistic: failed', {
        recordingId: msg.recordingId,
        err: reason,
      });
      await markFailed(msg.recordingId, reason);
      throw err;
    }
  }
};
