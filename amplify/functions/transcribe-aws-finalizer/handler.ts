import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { parseTranscribeResult, type TranscribeOutputJson } from '../transcribe-aws/result-parser';
import { recordingIdFromJobName } from '../transcribe-aws/job-name';
import { meanWordConfidence } from './confidence';

/**
 * Amazon Transcribe async finalizer Lambda (#585, epic #582).
 *
 * EventBridge-triggered on `source: aws.transcribe`,
 * `detail-type: "Transcribe Job State Change"` (states COMPLETED +
 * FAILED — the rule in `backend.ts` scopes the subscription). The
 * backend Lambda (`transcribe-aws/handler.ts`) does NOT wait for the
 * job; this Lambda does the back half:
 *
 *   1. Recover the recordingId embedded in the job name. A name we
 *      cannot decode (foreign job, malformed) → log + no-op. We do
 *      NOT throw: EventBridge retries a throwing target, and a job
 *      name we can't parse will never parse, so throwing would loop
 *      forever / fill the DLQ with un-actionable events.
 *   2. COMPLETED → GetObject the output JSON at
 *      `pipeline-temp/<recordingId>/transcribe.json` →
 *      `parseTranscribeResult` (reused from #56) → transcript text +
 *      per-word confidences → arithmetic-mean recording-level
 *      `transcriptionConfidence` (#581) → SendMessage a
 *      `{kind:'transcript', …}` to the linguistic queue.
 *   3. FAILED (or an empty/silent transcript, which
 *      `parseTranscribeResult` throws on) → SendMessage a
 *      `{kind:'transcribe-failure', …}` to the linguistic queue.
 *
 * The two message shapes are byte-for-byte the contract the Whisper
 * container publishes (`transcribe-whisper/handler.mjs`), so the
 * linguistic handler's `parseMessage` accepts them unchanged — every
 * backend funnels through one linguistic consumer.
 *
 * Test seam: `__setDeps({ s3, sqs })` injects mocked clients.
 */

const STATE_COMPLETED = 'COMPLETED';
const STATE_FAILED = 'FAILED';

export interface JobStateEvent {
  jobName: string;
  status: string;
  failureReason: string | null;
}

export interface FinalizerDeps {
  s3?: S3Client;
  sqs?: SQSClient;
  now?: () => Date;
}

let injected: FinalizerDeps = {};

export function __setDeps(deps: FinalizerDeps): void {
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

function nowIso(): string {
  return (injected.now ? injected.now() : new Date()).toISOString();
}

/**
 * Narrows an EventBridge event to the fields we need. Returns `null`
 * for anything that isn't a Transcribe job-state-change event so the
 * handler no-ops on noise.
 */
export function parseJobStateEvent(raw: unknown): JobStateEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const evt = raw as { source?: unknown; detail?: unknown };
  if (evt.source !== 'aws.transcribe') return null;
  const detail = evt.detail;
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  const jobName = d.TranscriptionJobName;
  const status = d.TranscriptionJobStatus;
  if (typeof jobName !== 'string' || typeof status !== 'string') return null;
  return {
    jobName,
    status,
    failureReason: typeof d.FailureReason === 'string' ? d.FailureReason : null,
  };
}

async function publishTranscript(
  queueUrl: string,
  recordingId: string,
  transcript: string,
  transcriptionConfidence: number | null,
): Promise<void> {
  await sqs().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        kind: 'transcript',
        recordingId,
        transcript,
        // Only emit the field when we actually have a value — an
        // absent `transcriptionConfidence` means "unknown", which the
        // linguistic handler treats as unset rather than low.
        ...(transcriptionConfidence !== null ? { transcriptionConfidence } : {}),
        enqueuedAt: nowIso(),
      }),
    }),
  );
}

async function publishFailure(
  queueUrl: string,
  recordingId: string,
  reason: string,
): Promise<void> {
  await sqs().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        kind: 'transcribe-failure',
        recordingId,
        reason: reason.slice(0, 1024),
        enqueuedAt: nowIso(),
      }),
    }),
  );
}

async function fetchOutputJson(bucket: string, key: string): Promise<TranscribeOutputJson> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body as { transformToString?: () => Promise<string> } | undefined;
  if (!body || typeof body.transformToString !== 'function') {
    throw new Error(`transcribe-aws-finalizer: empty S3 body for s3://${bucket}/${key}`);
  }
  const text = await body.transformToString();
  return JSON.parse(text) as TranscribeOutputJson;
}

export async function handler(event: unknown): Promise<void> {
  const queueUrl = process.env.LINGUISTIC_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('transcribe-aws-finalizer: LINGUISTIC_QUEUE_URL env var is unset');
  }

  const parsed = parseJobStateEvent(event);
  if (!parsed) {
    console.warn('transcribe-aws-finalizer: ignoring non-Transcribe / malformed event');
    return;
  }

  const recordingId = recordingIdFromJobName(parsed.jobName);
  if (!recordingId) {
    // Unrecoverable — never throw (EventBridge would retry forever).
    console.warn('transcribe-aws-finalizer: could not decode recordingId from job name; no-op', {
      jobName: parsed.jobName,
      status: parsed.status,
    });
    return;
  }

  if (parsed.status === STATE_FAILED) {
    const reason = parsed.failureReason ?? 'Amazon Transcribe job FAILED (no reason reported)';
    await publishFailure(queueUrl, recordingId, reason);
    console.info('transcribe-aws-finalizer: published transcribe-failure (job FAILED)', {
      recordingId,
      reason: reason.slice(0, 256),
    });
    return;
  }

  if (parsed.status !== STATE_COMPLETED) {
    // Non-terminal state (QUEUED / IN_PROGRESS) — nothing to do. The
    // EventBridge rule should scope to COMPLETED/FAILED, but guard
    // here too so a broader rule can't make us act prematurely.
    console.info('transcribe-aws-finalizer: ignoring non-terminal job state', {
      recordingId,
      status: parsed.status,
    });
    return;
  }

  // COMPLETED.
  const bucket = process.env.RECORDINGS_BUCKET;
  if (!bucket) {
    throw new Error('transcribe-aws-finalizer: RECORDINGS_BUCKET env var is unset');
  }
  const tempPrefix = process.env.PIPELINE_TEMP_PREFIX ?? 'pipeline-temp';
  const outputKey = `${tempPrefix}/${recordingId}/transcribe.json`;

  let output: TranscribeOutputJson;
  try {
    output = await fetchOutputJson(bucket, outputKey);
  } catch (err) {
    // The job completed but we can't read / parse its output. This is
    // a real failure (S3 read error / corrupt JSON) — rethrow so
    // EventBridge redrives; a transient S3 blip is worth a retry, and
    // a persistent one lands on the rule's DLQ for human eyes.
    console.error('transcribe-aws-finalizer: failed to read transcription output', {
      recordingId,
      outputKey,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  let transcript: string;
  let confidence: number | null;
  try {
    const result = parseTranscribeResult(output);
    transcript = result.text;
    confidence = meanWordConfidence(result.words);
  } catch (err) {
    // `parseTranscribeResult` throws on an empty/silent transcript or
    // a malformed result shape. Per CLAUDE.md → Pipeline components,
    // an empty transcript is a failed-transcription outcome, NOT a
    // valid empty Message. Route it to the failure path so the
    // recording lands `transcription_failed=true` with no Message.
    const reason = err instanceof Error ? err.message : 'Amazon Transcribe output unparseable';
    await publishFailure(queueUrl, recordingId, reason);
    console.info('transcribe-aws-finalizer: published transcribe-failure (empty/unparseable)', {
      recordingId,
      reason: reason.slice(0, 256),
    });
    return;
  }

  await publishTranscript(queueUrl, recordingId, transcript, confidence);
  console.info('transcribe-aws-finalizer: published transcript to linguistic queue', {
    recordingId,
    transcriptLen: transcript.length,
    transcriptionConfidence: confidence,
  });
}
