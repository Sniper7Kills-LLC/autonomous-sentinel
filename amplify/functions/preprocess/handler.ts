import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

/**
 * Pre-process Lambda (#433 stage 2).
 *
 * Triggered by SQS messages on the preprocess queue. Each message
 * carries `{ recordingId, originalKey, contentHash, enqueuedAt }`
 * published by `submitRecording`.
 *
 * v1 behavior (transcoding deferred):
 *   1. Read the SQS message; resolve the original S3 key.
 *   2. HEAD the original to confirm it exists + capture size.
 *   3. Copy the original to `recordings/web/<recordingId><ext>` so the
 *      transcribe stage has a stable web-key. **No ffmpeg transcode
 *      yet** — the v1 canonical is the original bytes. ffmpeg-driven
 *      Opus 32 kbps mono encoding will land once a Lambda layer (or
 *      container Lambda) is wired up — tracked in #433 follow-up.
 *   4. Update the Recording row: set `webCanonicalKey`,
 *      `canonicalSizeBytes`, and advance
 *      `transcriptionStatus = TRANSCRIBING`.
 *   5. Publish a transcribe-queue message `{ recordingId, audioKey }`
 *      so the Whisper container Lambda picks the recording up.
 *
 * Failure paths:
 *   - Malformed SQS body → log + skip (consumed; can't usefully redrive).
 *   - Anything else → rethrow so SQS marks the message for redrive /
 *     eventual DLQ; the Recording row stays at QUEUED so an operator
 *     sees the hang.
 *
 * The handler does NOT use the Amplify Data client (which adds a
 * 20+ MB cold-start cost) — it issues a direct DynamoDB UpdateItem
 * against the `RECORDING_TABLE_NAME` env var.
 *
 * Idempotency: a redrived SQS message re-runs the full COPY + DDB
 * UpdateItem + transcribe-queue publish. CopyObject is idempotent
 * (writes the same bytes to the same key), the UpdateItem `SET`
 * idempotently rewrites the same fields, and the downstream
 * transcribe-queue consumer (Whisper) is itself idempotent
 * (re-runs against the same audio yield the same transcript +
 * the same DDB writes). A duplicated SQS publish on this stage is
 * therefore harmless — accepted as a design decision rather than
 * guarded with a `ConditionExpression`.
 */

interface PreprocessQueueMessage {
  recordingId: string;
  originalKey: string;
  contentHash: string;
  enqueuedAt: string;
}

interface TranscribeQueueMessage {
  recordingId: string;
  audioKey: string;
  enqueuedAt: string;
}

export interface PreprocessDeps {
  s3?: S3Client;
  sqs?: SQSClient;
  ddb?: DynamoDBClient;
  now?: () => Date;
}

let injected: PreprocessDeps = {};

export function __setDeps(deps: PreprocessDeps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedS3: S3Client | undefined;
function s3(): S3Client {
  return injected.s3 ?? (cachedS3 ??= new S3Client({}));
}

let cachedSqs: SQSClient | undefined;
function sqs(): SQSClient {
  return injected.sqs ?? (cachedSqs ??= new SQSClient({}));
}

let cachedDdb: DynamoDBClient | undefined;
function ddb(): DynamoDBClient {
  return injected.ddb ?? (cachedDdb ??= new DynamoDBClient({}));
}

function nowIso(): string {
  return (injected.now ?? (() => new Date()))().toISOString();
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`preprocess: ${name} env var is required`);
  return v;
}

function extensionOf(key: string): string {
  const dot = key.lastIndexOf('.');
  return dot >= 0 ? key.slice(dot) : '';
}

export function buildWebKey(recordingId: string, originalKey: string): string {
  return `recordings/web/${recordingId}${extensionOf(originalKey)}`;
}

export function parseMessage(body: string): PreprocessQueueMessage {
  const parsed = JSON.parse(body) as Partial<PreprocessQueueMessage>;
  if (!parsed.recordingId || !parsed.originalKey || !parsed.contentHash) {
    throw new Error(`preprocess: SQS body missing required fields: ${JSON.stringify(parsed)}`);
  }
  return {
    recordingId: parsed.recordingId,
    originalKey: parsed.originalKey,
    contentHash: parsed.contentHash,
    enqueuedAt: parsed.enqueuedAt ?? nowIso(),
  };
}

async function processOne(msg: PreprocessQueueMessage): Promise<void> {
  const bucket = requiredEnv('RECORDINGS_BUCKET');
  const tableName = requiredEnv('RECORDING_TABLE_NAME');
  const transcribeQueueUrl = requiredEnv('TRANSCRIBE_QUEUE_URL');

  const webKey = buildWebKey(msg.recordingId, msg.originalKey);

  const head = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: msg.originalKey }));
  const sizeBytes = head.ContentLength ?? 0;

  // CopySource format = `${bucket}/${url-encoded-key}` — the slash
  // is a delimiter and must NOT be encoded, only the key part is
  // URL-encoded (per AWS S3 docs). Previous shape
  // `encodeURIComponent(\`${bucket}/${key}\`)` percent-encoded the
  // delimiter slash and AWS rejected the copy with
  // "Invalid Copy Source".
  await s3().send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(msg.originalKey)}`,
      Key: webKey,
      MetadataDirective: 'REPLACE',
      Metadata: {
        'recording-id': msg.recordingId,
        'content-hash': msg.contentHash,
      },
    }),
  );

  const ts = nowIso();
  await ddb().send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: marshall({ id: msg.recordingId }),
      UpdateExpression: 'SET #wck = :wck, #csb = :csb, #ts = :ts, #tsu = :tsu',
      ExpressionAttributeNames: {
        '#wck': 'webCanonicalKey',
        '#csb': 'canonicalSizeBytes',
        '#ts': 'transcriptionStatus',
        '#tsu': 'transcriptionStatusUpdatedAt',
      },
      ExpressionAttributeValues: marshall({
        ':wck': webKey,
        ':csb': sizeBytes,
        ':ts': 'TRANSCRIBING',
        ':tsu': ts,
      }),
    }),
  );

  const transcribeMsg: TranscribeQueueMessage = {
    recordingId: msg.recordingId,
    audioKey: webKey,
    enqueuedAt: ts,
  };
  await sqs().send(
    new SendMessageCommand({
      QueueUrl: transcribeQueueUrl,
      MessageBody: JSON.stringify(transcribeMsg),
    }),
  );
}

// `_context` / `_callback` declared explicitly so the test fixtures
// that pass all three Lambda-runtime arguments don't trip CodeQL's
// "Superfluous trailing arguments" rule.
export const handler: SQSHandler = async (event: SQSEvent, _context, _callback) => {
  for (const record of event.Records) {
    let msg: PreprocessQueueMessage;
    try {
      msg = parseMessage(record.body);
    } catch (err) {
      console.error('preprocess: invalid SQS body, skipping', {
        body: record.body,
        err: String(err),
      });
      continue;
    }
    try {
      await processOne(msg);
      console.info('preprocess: advanced to TRANSCRIBING', {
        recordingId: msg.recordingId,
      });
    } catch (err) {
      console.error('preprocess: failed', {
        recordingId: msg.recordingId,
        err: String(err),
      });
      throw err;
    }
  }
};
