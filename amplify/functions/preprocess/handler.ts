import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { hasReachedStatus } from '../_shared/recording-status';

/**
 * Pre-process Lambda (#433 stage 2 / consolidated #514).
 *
 * Triggered by SQS messages on the preprocess queue. Each message
 * carries `{ recordingId, originalKey, contentHash, enqueuedAt }`
 * published by `submitRecording`.
 *
 * Behavior (the ffmpeg transcode now lives in the Whisper container —
 * #514 — which produces the web-canonical Opus + the transcript in one
 * pass; preprocess no longer transcodes or copies):
 *   1. HEAD the original to confirm it exists.
 *   2. Advance the Recording to `TRANSCRIBING` via the Amplify Data
 *      client so the portal `observeQuery` subscription fires (a raw
 *      DDB write would bypass AppSync's subscription publisher).
 *   3. Publish a transcribe-queue message `{ recordingId, originalKey,
 *      contentHash }` — the Whisper container downloads the original,
 *      transcodes to `recordings/web/<id>.opus`, and transcribes it.
 *
 * Failure paths:
 *   - Malformed SQS body → log + skip (consumed; can't usefully redrive).
 *   - Anything else → set `transcriptionStatus = PREPROCESS_FAILED` +
 *     `failedReason` on the Recording row so admin DLQ UI / portal
 *     show the stuck state, then rethrow so SQS marks the message
 *     for redrive / eventual DLQ.
 *
 * Idempotency: a redrived SQS message re-runs HEAD + update + publish;
 * all three are idempotent and the downstream Whisper consumer is too.
 */

interface PreprocessQueueMessage {
  recordingId: string;
  originalKey: string;
  contentHash: string;
  enqueuedAt: string;
  /**
   * Per-recording transcribe-backend override (#592). Set by an admin
   * `reprocessRecording` with a chosen backend; forwarded verbatim onto
   * the transcribe message below so the dispatcher (#587/#589) routes to
   * it. Absent on a normal upload (the dispatcher then uses the env-wide
   * admin default / `whisper-local`).
   */
  backendOverride?: string;
}

interface TranscribeQueueMessage {
  recordingId: string;
  originalKey: string;
  contentHash: string;
  enqueuedAt: string;
  /** See PreprocessQueueMessage.backendOverride (#592). */
  backendOverride?: string;
  /**
   * Admin-configured Whisper initial prompt (#771). Read from the
   * `WHISPER_INITIAL_PROMPT` LinguisticConfig row and forwarded verbatim by
   * the dispatcher so the Whisper container uses it without a DB client.
   * Omitted when unset → the container falls back to its baked default.
   */
  initialPrompt?: string;
}

/** LinguisticConfig key holding the admin-tunable Whisper prompt (#771). */
export const WHISPER_INITIAL_PROMPT_CONFIG_KEY = 'WHISPER_INITIAL_PROMPT';

/**
 * Best-effort read of the admin Whisper prompt (#771). Returns the string
 * value (including '' to disable priming) or undefined when the row is
 * absent / unreadable / non-string — never throws, so a config hiccup can't
 * block the pipeline.
 */
export async function loadWhisperInitialPrompt(
  client: PreprocessDataClient,
): Promise<string | undefined> {
  try {
    const res = await client.models.LinguisticConfig.get({
      key: WHISPER_INITIAL_PROMPT_CONFIG_KEY,
    });
    const value = res.data?.value;
    return typeof value === 'string' ? value : undefined;
  } catch (err) {
    console.warn('preprocess: WHISPER_INITIAL_PROMPT read failed (using container default)', {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Narrow surface the handler uses from `generateClient<Schema>()`.
 * Keeps the typing crisp without dragging the full Amplify Data
 * client surface into the test file.
 */
export interface PreprocessDataClient {
  models: {
    Recording: {
      get: (input: { id: string }) => Promise<{
        data: { id: string; transcriptionStatus?: string | null } | null;
        errors?: unknown;
      }>;
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
    /**
     * Admin-tunable Linguistic config (#771). Read-only here — the
     * preprocess Lambda fetches the `WHISPER_INITIAL_PROMPT` row to inject
     * the prompt into the transcribe-queue message so the lean Whisper
     * container needs no DB client of its own.
     */
    LinguisticConfig: {
      get: (input: { key: string }) => Promise<{
        data: { value?: unknown } | null;
        errors?: unknown;
      }>;
    };
  };
}

export interface PreprocessDeps {
  s3?: S3Client;
  sqs?: SQSClient;
  dataClient?: PreprocessDataClient;
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
    // Forward the override only when it's a non-empty string (#592). The
    // value is re-validated downstream by the dispatcher's selector, which
    // falls through to the default on anything unrecognized — so a bad
    // value here degrades gracefully rather than dropping the recording.
    ...(typeof parsed.backendOverride === 'string' && parsed.backendOverride.length > 0
      ? { backendOverride: parsed.backendOverride }
      : {}),
  };
}

interface ProcessOneResult {
  /** The original upload key handed to the transcribe stage. */
  originalKey: string;
  /** Original size (bytes) for the log. */
  inputSizeBytes: number;
  /** True when the recording had already advanced past this stage (#741). */
  skipped?: boolean;
}

async function processOne(msg: PreprocessQueueMessage): Promise<ProcessOneResult> {
  const bucket = requiredEnv('RECORDINGS_BUCKET');
  const transcribeQueueUrl = requiredEnv('TRANSCRIBE_QUEUE_URL');
  const client = await dataClient();

  // #741: skip if the recording has already reached/passed TRANSCRIBING — a
  // stray/duplicate SQS delivery or redrive must not regress an
  // already-advanced (or terminal) recording. Reading the current status
  // first keeps the subscription-firing Amplify Data write path (vs a raw
  // DDB ConditionExpression). Admin reprocess resets the row to QUEUED, so
  // legitimate re-runs are never blocked.
  const existing = await client.models.Recording.get({ id: msg.recordingId });
  if (hasReachedStatus(existing.data?.transcriptionStatus, 'TRANSCRIBING')) {
    return { originalKey: msg.originalKey, inputSizeBytes: 0, skipped: true };
  }

  // Advance QUEUED → PREPROCESSING the moment the stage picks the
  // recording up, so the My Uploads badge reflects this step (#433 status
  // ladder). Best-effort: the authoritative transition is the TRANSCRIBING
  // write below, so a failure here is cosmetic — log rather than throw, to
  // avoid DLQ-ing an otherwise-fine job on a flaky status write.
  const preprocessingUpdate = await client.models.Recording.update({
    id: msg.recordingId,
    transcriptionStatus: 'PREPROCESSING',
    transcriptionStatusUpdatedAt: nowIso(),
  });
  if (preprocessingUpdate.errors) {
    console.warn('preprocess: failed to mark Recording PREPROCESSING (continuing)', {
      recordingId: msg.recordingId,
      errors: preprocessingUpdate.errors,
    });
  }

  // Validate the original exists. The Whisper container does the ffmpeg
  // transcode now (#514), so preprocess only advances state + hands the
  // original key to the transcribe queue.
  const head = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: msg.originalKey }));
  const inputSizeBytes = head.ContentLength ?? 0;

  const ts = nowIso();
  // Routed through Amplify Data so AppSync's subscription publisher
  // fires for the portal's observeQuery on Recording. webCanonicalKey
  // + canonicalSizeBytes are set later by linguistic from the Whisper
  // container's transcript message (the container produces the Opus).
  const updateResult = await client.models.Recording.update({
    id: msg.recordingId,
    transcriptionStatus: 'TRANSCRIBING',
    transcriptionStatusUpdatedAt: ts,
  });
  if (updateResult.errors) {
    throw new Error(
      `preprocess: Recording.update returned errors: ${JSON.stringify(updateResult.errors)}`,
    );
  }

  // Admin-tunable Whisper prompt (#771) — injected here so the lean Whisper
  // container (no DB client) gets it via the dispatcher's verbatim forward.
  // Best-effort: a config hiccup leaves it unset → container baked default.
  const initialPrompt = await loadWhisperInitialPrompt(client);

  const transcribeMsg: TranscribeQueueMessage = {
    recordingId: msg.recordingId,
    originalKey: msg.originalKey,
    contentHash: msg.contentHash,
    enqueuedAt: ts,
    // Forward the admin-chosen backend override (#592) so the dispatcher
    // routes this recording to it.
    ...(msg.backendOverride ? { backendOverride: msg.backendOverride } : {}),
    // Include the prompt only when configured (incl. '' to disable priming).
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
  };
  await sqs().send(
    new SendMessageCommand({
      QueueUrl: transcribeQueueUrl,
      MessageBody: JSON.stringify(transcribeMsg),
    }),
  );

  return { originalKey: msg.originalKey, inputSizeBytes };
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
      if (result.skipped) {
        console.info('preprocess: skipped — recording already past TRANSCRIBING (#741)', {
          recordingId: msg.recordingId,
        });
      } else {
        console.info('preprocess: validated + advanced to TRANSCRIBING', {
          recordingId: msg.recordingId,
          originalKey: result.originalKey,
          inputSizeBytes: result.inputSizeBytes,
          note: 'transcode happens in the Whisper container (#514)',
        });
      }
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
