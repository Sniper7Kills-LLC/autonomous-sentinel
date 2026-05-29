/**
 * Whisper container Lambda handler (#54 / #433 stage 3).
 *
 * Runs INSIDE the container image (`Dockerfile`); the build copies
 * this file as `${LAMBDA_TASK_ROOT}/handler.mjs`. Container Lambda
 * `CMD ["handler.handler"]` points the runtime here.
 *
 * Per SQS message (one Recording per invoke per `batchSize: 1`):
 *   1. Read the SQS body: `{ recordingId, audioKey, enqueuedAt }`
 *      (audioKey is set by the preprocess Lambda — usually
 *      `recordings/web/<id><ext>`).
 *   2. Download the audio from S3 to /tmp.
 *   3. Run `/opt/whisper` against the medium English model.
 *   4. Read the `<id>.json` whisper.cpp output.
 *   5. Stage the raw whisper JSON in `pipeline-temp/<id>/whisper.json`
 *      for future word-timestamp use.
 *   6. Publish onto the linguistic queue with the transcript so the
 *      linguistic Lambda picks the recording up + persists the
 *      transcript + status via Amplify Data (#452 — Recording state
 *      changes MUST route through AppSync so the portal's
 *      `observeQuery` subscription fires; direct DDB writes from
 *      the container bypass the subscription publisher).
 *   7. Clean up /tmp.
 *
 * Failure path: publish a `failure` message to the linguistic queue
 * carrying `recordingId` + `reason` (#452). Linguistic owns the
 * Recording state machine + writes `TRANSCRIBE_FAILED` via Amplify
 * Data so the portal subscription fires. The handler then throws so
 * SQS redrives the Whisper message per `maxReceiveCount`; eventual
 * DLQ landing for the original Whisper message is unaffected because
 * the failure-status publish is idempotent.
 *
 * No DDB writes from this Lambda. The image deliberately doesn't
 * carry `aws-amplify`; routing state through the linguistic Lambda
 * keeps the container small while restoring subscription coverage.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWhisperConfig, runWhisper, WhisperError } from './run-whisper.mjs';
import { transcodeToOpus } from './opus-transcode.mjs';

const RECORDINGS_BUCKET = process.env.RECORDINGS_BUCKET ?? '';
const PIPELINE_TEMP_PREFIX = process.env.PIPELINE_TEMP_PREFIX ?? 'pipeline-temp';
const RECORDINGS_WEB_PREFIX = process.env.RECORDINGS_WEB_PREFIX ?? 'recordings/web';
const LINGUISTIC_QUEUE_URL = process.env.LINGUISTIC_QUEUE_URL ?? '';
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? '/usr/local/bin/ffmpeg';

// Build identity baked into the image at `docker build` time
// (#442 follow-up). Lets the cold-start log + per-invoke
// "advanced to PARSING" entry confirm which image is actually
// running, independent of CFN's Lambda code reference.
const IMAGE_GIT_SHA = process.env.GIT_SHA ?? 'unknown';
const IMAGE_BUILD_ID = process.env.BUILD_ID ?? 'unknown';

const s3 = new S3Client({});
const sqs = new SQSClient({});

console.info('whisper-handler: image identity', {
  gitSha: IMAGE_GIT_SHA,
  buildId: IMAGE_BUILD_ID,
});

export async function handler(event) {
  if (!RECORDINGS_BUCKET) {
    throw new Error('whisper-handler: RECORDINGS_BUCKET env var is unset');
  }
  if (!LINGUISTIC_QUEUE_URL) {
    throw new Error('whisper-handler: LINGUISTIC_QUEUE_URL env var is unset');
  }
  const records = event?.Records ?? [];
  for (const record of records) {
    const body = parseBody(record);
    if (!body) continue;
    await processOne(body);
  }
  return { ok: true };
}

function parseBody(record) {
  try {
    return JSON.parse(record?.body ?? '');
  } catch (err) {
    console.error('whisper-handler: invalid SQS body JSON', {
      error: String(err),
    });
    return null;
  }
}

function audioKeyFor(body) {
  // Stage 3 messages carry the resolved web-audio key. Fall back to
  // the legacy `recordings/web/<id>.opus` shape for any messages
  // that may have been published by an older preprocess build still
  // in flight at deploy time.
  if (typeof body.audioKey === 'string' && body.audioKey.length > 0) {
    return body.audioKey;
  }
  return `recordings/web/${body.recordingId}.opus`;
}

function extensionOf(key) {
  const dot = key.lastIndexOf('.');
  return dot >= 0 ? key.slice(dot) : '';
}

async function publishFailure(recordingId, reason) {
  // Caller wraps in its own try/catch so the original Whisper error
  // is preserved as the throw value even if this publish itself
  // fails. We don't swallow here — silently dropping a failure
  // publish would leave the Recording stuck in TRANSCRIBING limbo
  // until SQS retries time out (#453 self-review).
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: LINGUISTIC_QUEUE_URL,
      MessageBody: JSON.stringify({
        kind: 'transcribe-failure',
        recordingId,
        reason: reason.slice(0, 1024),
        enqueuedAt: new Date().toISOString(),
      }),
    }),
  );
}

async function processOne(body) {
  const { recordingId } = body;
  if (!recordingId || typeof recordingId !== 'string') {
    throw new Error('whisper-handler: SQS body missing recordingId');
  }
  const config = readWhisperConfig(process.env);
  const tmpDir = join(tmpdir(), `whisper-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });

  const outputPrefix = join(tmpDir, recordingId);
  const cleanupPaths = [`${outputPrefix}.json`];

  // Consolidated path (#514): the message carries the ORIGINAL upload
  // key. Download it, transcode to the web-canonical Opus (the
  // browser-playback file), upload it, then run whisper on it — one
  // image does transcode + transcribe. webCanonicalKey/size ride the
  // transcript message so the linguistic Lambda persists them.
  //
  // Legacy path: the message carries `audioKey` (web Opus already
  // produced by an older preprocess build still in flight). Download +
  // transcribe with no transcode. Kept for back-compat during rollout.
  let whisperInputPath;
  let webCanonicalKey;
  let canonicalSizeBytes;

  try {
    if (typeof body.originalKey === 'string' && body.originalKey.length > 0) {
      const origExt = extensionOf(body.originalKey);
      const origPath = join(tmpDir, `original${origExt}`);
      const opusPath = join(tmpDir, `${recordingId}.opus`);
      await downloadFromS3(RECORDINGS_BUCKET, body.originalKey, origPath);
      await transcodeToOpus({ inputPath: origPath, outputPath: opusPath, ffmpegPath: FFMPEG_PATH });
      const opusBuf = await readFile(opusPath);
      webCanonicalKey = `${RECORDINGS_WEB_PREFIX}/${recordingId}.opus`;
      canonicalSizeBytes = opusBuf.length;
      await s3.send(
        new PutObjectCommand({
          Bucket: RECORDINGS_BUCKET,
          Key: webCanonicalKey,
          Body: opusBuf,
          ContentType: 'audio/ogg; codecs=opus',
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: { 'recording-id': recordingId },
        }),
      );
      whisperInputPath = opusPath;
      cleanupPaths.push(origPath, opusPath);
    } else {
      const audioKey = audioKeyFor(body);
      const inputExt = extensionOf(audioKey) || '.opus';
      whisperInputPath = join(tmpDir, `${recordingId}${inputExt}`);
      await downloadFromS3(RECORDINGS_BUCKET, audioKey, whisperInputPath);
      cleanupPaths.push(whisperInputPath);
    }

    const result = await runWhisper({
      inputPath: whisperInputPath,
      outputPrefix,
      language: config.language,
      threads: config.threads,
      whisperBinary: config.whisperBinary,
      modelPath: config.modelPath,
    });

    const transcriptJson = await readFile(result.jsonOutputPath, 'utf8');
    const transcriptText = extractTranscriptText(transcriptJson);

    // Persist the whisper JSON as the canonical word-timestamps
    // sidecar (#92). Lands at `recordings/web/<id>.words.json` so
    // the web `<AudioPlayer>` can fetch it via Amplify Storage
    // without a signed-URL Lambda (the `recordings/web/*` prefix
    // already grants `allow.guest.to(['read'])`).
    const wordTimestampsKey = `${RECORDINGS_WEB_PREFIX}/${recordingId}.words.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: RECORDINGS_BUCKET,
        Key: wordTimestampsKey,
        Body: transcriptJson,
        ContentType: 'application/json',
      }),
    );

    // Pipeline-temp duplicate kept as a short-lived debugging copy.
    // Lifecycle policy expires this prefix after 7 days; the canonical
    // copy at `recordings/web/*` is the long-lived asset.
    await s3.send(
      new PutObjectCommand({
        Bucket: RECORDINGS_BUCKET,
        Key: `${PIPELINE_TEMP_PREFIX}/${recordingId}/whisper.json`,
        Body: transcriptJson,
        ContentType: 'application/json',
      }),
    );

    // Publish onto the linguistic queue. Linguistic owns the
    // Recording.update for `transcript` + status + the new
    // `wordTimestampsKey` field (#452 + #92).
    const ts = new Date().toISOString();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: LINGUISTIC_QUEUE_URL,
        MessageBody: JSON.stringify({
          kind: 'transcript',
          recordingId,
          transcript: transcriptText,
          wordTimestampsKey,
          // Only present on the consolidated path — the container
          // produced the web-canonical Opus, so linguistic persists
          // its key + size on the Recording.
          ...(webCanonicalKey ? { webCanonicalKey, canonicalSizeBytes } : {}),
          enqueuedAt: ts,
        }),
      }),
    );

    console.info('whisper-handler: published transcript to linguistic queue', {
      recordingId,
      transcriptLen: transcriptText.length,
      wordTimestampsKey,
      webCanonicalKey: webCanonicalKey ?? '(legacy audioKey path)',
      stderrTail: result.stderrTail.slice(-256),
      gitSha: IMAGE_GIT_SHA,
      buildId: IMAGE_BUILD_ID,
    });
  } catch (err) {
    if (err instanceof WhisperError) {
      console.error('whisper-handler: whisper.cpp failed', {
        recordingId,
        code: err.code,
        signal: err.signal,
        stderr: err.stderr.slice(-1024),
      });
    } else {
      console.error('whisper-handler: unexpected failure', {
        recordingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const reason =
      err instanceof WhisperError
        ? `whisper.cpp ${err.signal ? `signal ${err.signal}` : `exit ${err.code}`}: ${err.stderr.slice(-512)}`
        : err instanceof Error
          ? err.message
          : String(err);
    // Route the failure through the linguistic queue so the linguistic
    // Lambda can mark TRANSCRIBE_FAILED via Amplify Data and the portal
    // subscription fires (#452). Wrap so a publish-side failure logs
    // without shadowing the original Whisper error; SQS still redrives
    // the Whisper message either way.
    try {
      await publishFailure(recordingId, reason);
    } catch (publishErr) {
      console.error('whisper-handler: failure-publish also failed; SQS will redrive', {
        recordingId,
        originalReason: reason,
        publishErr: publishErr instanceof Error ? publishErr.message : String(publishErr),
      });
    }
    throw err;
  } finally {
    await Promise.allSettled(cleanupPaths.map((p) => unlink(p).catch(() => undefined)));
  }
}

function extractTranscriptText(jsonString) {
  // whisper.cpp JSON shape:
  //   { transcription: [ { text, offsets, ... }, ... ], ... }
  // Fall back to top-level `text` if present.
  try {
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed?.transcription)) {
      return parsed.transcription
        .map((seg) => String(seg?.text ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    if (typeof parsed?.text === 'string') return parsed.text.trim();
  } catch {
    // fall through
  }
  return '';
}

async function downloadFromS3(bucket, key, destPath) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`whisper-handler: empty S3 body for s3://${bucket}/${key}`);
  }
  await pipeline(response.Body, createWriteStream(destPath));
}
