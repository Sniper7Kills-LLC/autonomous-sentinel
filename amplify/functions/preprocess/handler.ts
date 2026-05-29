import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { transcodeWebCanonical, type TranscodeWebResult } from './transcode-web';

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
 *      yet** — the v1 canonical is the original bytes.
 *   4. Update the Recording row via the Amplify Data client so the
 *      testing portal's `observeQuery` subscription on Recording
 *      fires. Raw DDB writes would bypass AppSync's subscription
 *      publisher and the portal user would never see the row
 *      advance.
 *   5. Publish a transcribe-queue message `{ recordingId, audioKey }`
 *      so the Whisper container Lambda picks the recording up.
 *
 * Failure paths:
 *   - Malformed SQS body → log + skip (consumed; can't usefully redrive).
 *   - Anything else → set `transcriptionStatus = PREPROCESS_FAILED` +
 *     `failedReason` on the Recording row so admin DLQ UI / portal
 *     show the stuck state, then rethrow so SQS marks the message
 *     for redrive / eventual DLQ.
 *
 * Idempotency: a redrived SQS message re-runs the full COPY + update
 * + transcribe-queue publish. CopyObject is idempotent, the Amplify
 * Data update is a SET on the same fields, and the downstream
 * transcribe-queue consumer (Whisper) is itself idempotent. A
 * duplicated SQS publish on this stage is harmless.
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

/**
 * Narrow surface the handler uses from `generateClient<Schema>()`.
 * Keeps the typing crisp without dragging the full Amplify Data
 * client surface into the test file.
 */
export interface PreprocessDataClient {
  models: {
    Recording: {
      update: (input: {
        id: string;
        webCanonicalKey?: string | null;
        canonicalSizeBytes?: number | null;
        transcriptionStatus?: string;
        transcriptionStatusUpdatedAt?: string;
        transcriptionFailed?: boolean;
        failedReason?: string | null;
      }) => Promise<{ data: unknown; errors?: unknown }>;
    };
  };
}

export interface PreprocessDeps {
  s3?: S3Client;
  sqs?: SQSClient;
  dataClient?: PreprocessDataClient;
  now?: () => Date;
  /** Override the ffmpeg transcode orchestration in tests. */
  transcodeWeb?: (
    input: { bucket: string; originalKey: string; recordingId: string; contentHash?: string },
    deps: { s3: S3Client; ffmpegBinary?: string },
  ) => Promise<TranscodeWebResult>;
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

let cachedDataClient: PreprocessDataClient | undefined;
async function dataClient(): Promise<PreprocessDataClient> {
  if (injected.dataClient) return injected.dataClient;
  if (cachedDataClient) return cachedDataClient;
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedDataClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as PreprocessDataClient;
  return cachedDataClient;
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

interface ProcessOneResult {
  /** Source bucket key (what the uploader sent). */
  inputKey: string;
  /** Destination bucket key (web canonical). */
  outputKey: string;
  /** Original size, and the web-canonical output size. Equal on the
   * byte-copy fallback; the output shrinks on the transcode path. */
  inputSizeBytes: number;
  outputSizeBytes: number;
  /** File extensions for the conversion log. On the transcode path the
   * output is `.opus`; on the byte-copy fallback it mirrors the input. */
  inputExt: string;
  outputExt: string;
  /** True when ffmpeg transcoded to Opus (FFMPEG_PATH set); false on the
   * byte-for-byte copy fallback used until the ffmpeg layer is wired. */
  transcoded: boolean;
}

async function processOne(msg: PreprocessQueueMessage): Promise<ProcessOneResult> {
  const bucket = requiredEnv('RECORDINGS_BUCKET');
  const transcribeQueueUrl = requiredEnv('TRANSCRIBE_QUEUE_URL');
  const client = await dataClient();

  // Original size is reported either way for the conversion log.
  const head = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: msg.originalKey }));
  const inputSizeBytes = head.ContentLength ?? 0;

  // ffmpeg transcode is gated on FFMPEG_PATH (the Lambda layer's
  // `/opt/bin/ffmpeg`, wired once the layer is provisioned). Until
  // then we fall back to the byte-for-byte copy so the pipeline keeps
  // flowing — flipping the env on switches to real Opus output with
  // no code change (#503).
  const ffmpegPath = process.env.FFMPEG_PATH;
  let webKey: string;
  let outputSizeBytes: number;
  let transcoded: boolean;

  if (ffmpegPath) {
    const transcodeWeb = injected.transcodeWeb ?? transcodeWebCanonical;
    const result = await transcodeWeb(
      {
        bucket,
        originalKey: msg.originalKey,
        recordingId: msg.recordingId,
        contentHash: msg.contentHash,
      },
      { s3: s3(), ffmpegBinary: ffmpegPath },
    );
    webKey = result.webKey;
    outputSizeBytes = result.sizeBytes;
    transcoded = true;
  } else {
    webKey = buildWebKey(msg.recordingId, msg.originalKey);
    // CopySource format = `${bucket}/${url-encoded-key}` — the slash
    // is a delimiter and must NOT be encoded, only the key part is
    // URL-encoded (per AWS S3 docs).
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
    outputSizeBytes = inputSizeBytes;
    transcoded = false;
  }

  const ts = nowIso();
  // Routed through Amplify Data so AppSync's subscription publisher
  // fires for the portal's observeQuery on Recording.
  const updateResult = await client.models.Recording.update({
    id: msg.recordingId,
    webCanonicalKey: webKey,
    canonicalSizeBytes: outputSizeBytes,
    transcriptionStatus: 'TRANSCRIBING',
    transcriptionStatusUpdatedAt: ts,
  });
  if (updateResult.errors) {
    throw new Error(
      `preprocess: Recording.update returned errors: ${JSON.stringify(updateResult.errors)}`,
    );
  }

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

  const inputExt = extensionOf(msg.originalKey) || '<none>';
  const outputExt = extensionOf(webKey) || '<none>';
  return {
    inputKey: msg.originalKey,
    outputKey: webKey,
    inputSizeBytes,
    outputSizeBytes,
    inputExt,
    outputExt,
    transcoded,
  };
}

async function markFailed(recordingId: string, reason: string): Promise<void> {
  try {
    const client = await dataClient();
    await client.models.Recording.update({
      id: recordingId,
      transcriptionStatus: 'PREPROCESS_FAILED',
      transcriptionFailed: true,
      transcriptionStatusUpdatedAt: nowIso(),
      failedReason: reason.slice(0, 1024),
    });
  } catch (err) {
    // Don't let the failure-marker failure shadow the original error.
    console.error('preprocess: failed to mark Recording PREPROCESS_FAILED', {
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
      const result = await processOne(msg);
      // Detailed conversion summary — owner asked for explicit "what
      // did preprocess do" visibility. Once ffmpeg lands, `transcoded`
      // flips to true and the output sizes will diverge from input.
      console.info('preprocess: converted + advanced to TRANSCRIBING', {
        recordingId: msg.recordingId,
        inputKey: result.inputKey,
        outputKey: result.outputKey,
        inputExt: result.inputExt,
        outputExt: result.outputExt,
        inputSizeBytes: result.inputSizeBytes,
        outputSizeBytes: result.outputSizeBytes,
        transcoded: result.transcoded,
        note: result.transcoded
          ? 'transcoded'
          : 'byte-for-byte copy (ffmpeg transcode deferred — #433 follow-up)',
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('preprocess: failed', {
        recordingId: msg.recordingId,
        err: reason,
      });
      await markFailed(msg.recordingId, reason);
      throw err;
    }
  }
};
