import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
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
 *      pick a `Message.type` from the enum
 *      (`SKYKING`, `ALLSTATIONS`, `SKYBIRD`, `SKYMASTER`,
 *       `RADIOCHECK`, `DISREGARDED`, `OTHER`).
 *   2. Creates a Message row in DynamoDB with the parsed type +
 *      raw transcript body. Confidence is a coarse heuristic until
 *      the Bedrock fallback lands — see #433 follow-up.
 *   3. Updates the Recording row: `messageId` = new id,
 *      `transcriptionStatus = PUBLISHED`,
 *      `transcriptionStatusUpdatedAt = now`.
 *
 * v1 ships **rule-based parsing only** — the LinguisticConfig /
 * LinguisticRule / LinguisticPromptTemplate models plus Bedrock
 * fallback land in the follow-up. For now the rule set is hard-coded
 * here so the end-to-end pipeline runs without an admin-configured
 * rule editor.
 *
 * Failure rethrows so SQS redrives / DLQs; Recording stays at
 * PARSING for operator triage.
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

export interface LinguisticDeps {
  ddb?: DynamoDBClient;
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

let cachedDdb: DynamoDBClient | undefined;
function ddb(): DynamoDBClient {
  return injected.ddb ?? (cachedDdb ??= new DynamoDBClient({}));
}

function nowDate(): Date {
  return (injected.now ?? (() => new Date()))();
}

function uuid(): string {
  return (injected.uuid ?? randomUUID)();
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`linguistic: ${name} env var is required`);
  return v;
}

/**
 * Coarse keyword-driven classifier. Tested values are normalized
 * lowercase, whitespace-collapsed. Highest-specificity rule wins.
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
  const recordingTable = requiredEnv('RECORDING_TABLE_NAME');
  const messageTable = requiredEnv('MESSAGE_TABLE_NAME');
  const result = classify(msg.transcript);
  const messageId = uuid();
  const ts = nowDate().toISOString();

  // Field names mirror the Amplify Gen 2 Message model exactly
  // (`amplify/data/models/message.ts`):
  //   - `confidence` (not `confidenceScore`)
  //   - `broadcastTs` is `.required()` on the schema, so we MUST emit
  //     it. Use `enqueuedAt` as a stand-in for now — the upstream
  //     pipeline carries no native broadcast timestamp yet (#433
  //     follow-up: thread the SDR-captured broadcasted_at through
  //     submitRecording → preprocess → whisper → linguistic so this
  //     field reflects the real on-air time).
  await ddb().send(
    new PutItemCommand({
      TableName: messageTable,
      Item: marshall(
        {
          id: messageId,
          type: result.type,
          broadcastTs: msg.enqueuedAt,
          body: msg.transcript,
          confidence: result.confidence,
          flaggedForReview: result.confidence < 0.8,
          publishedAt: ts,
          createdAt: ts,
          updatedAt: ts,
          __typename: 'Message',
        },
        { removeUndefinedValues: true },
      ),
    }),
  );

  await ddb().send(
    new UpdateItemCommand({
      TableName: recordingTable,
      Key: marshall({ id: msg.recordingId }),
      UpdateExpression: 'SET #mid = :mid, #ts = :ts, #tsu = :tsu',
      ExpressionAttributeNames: {
        '#mid': 'messageId',
        '#ts': 'transcriptionStatus',
        '#tsu': 'transcriptionStatusUpdatedAt',
      },
      ExpressionAttributeValues: marshall({
        ':mid': messageId,
        ':ts': 'PUBLISHED',
        ':tsu': ts,
      }),
    }),
  );

  console.info('linguistic: published Message', {
    recordingId: msg.recordingId,
    messageId,
    type: result.type,
    confidence: result.confidence,
    rule: result.rule,
  });
}

export const handler: SQSHandler = async (event: SQSEvent) => {
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
      console.error('linguistic: failed', {
        recordingId: msg.recordingId,
        err: String(err),
      });
      throw err;
    }
  }
};
