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
 *   5. Persist transcript text onto the Recording row via DDB
 *      UpdateItem (status → PARSING, transcript set).
 *   6. Publish onto the linguistic queue so the linguistic Lambda
 *      picks the recording up.
 *   7. Stage the raw whisper JSON in `pipeline-temp/<id>/whisper.json`
 *      for future word-timestamp use.
 *   8. Clean up /tmp.
 *
 * Failure: any throw fails the SQS batch (`batchSize=1` so one
 * Recording per message); SQS redrives per the queue's
 * `maxReceiveCount`, then lands on the transcribe DLQ from #67.
 *
 * **Pre-#433 stage 3 the handler stopped after step 4** — staged the
 * JSON in pipeline-temp/ and deferred the row update + linguistic
 * handoff to an unwritten finalizer Lambda. That left the Recording
 * row stuck at TRANSCRIBING forever. This update folds the finalizer
 * directly into the Whisper handler.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWhisperConfig, runWhisper, WhisperError } from './run-whisper.mjs';

const RECORDINGS_BUCKET = process.env.RECORDINGS_BUCKET ?? '';
const PIPELINE_TEMP_PREFIX = process.env.PIPELINE_TEMP_PREFIX ?? 'pipeline-temp';
const RECORDING_TABLE_NAME = process.env.RECORDING_TABLE_NAME ?? '';
const LINGUISTIC_QUEUE_URL = process.env.LINGUISTIC_QUEUE_URL ?? '';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});

export async function handler(event) {
  if (!RECORDINGS_BUCKET) {
    throw new Error('whisper-handler: RECORDINGS_BUCKET env var is unset');
  }
  if (!RECORDING_TABLE_NAME) {
    throw new Error('whisper-handler: RECORDING_TABLE_NAME env var is unset');
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

async function processOne(body) {
  const { recordingId } = body;
  if (!recordingId || typeof recordingId !== 'string') {
    throw new Error('whisper-handler: SQS body missing recordingId');
  }
  const audioKey = audioKeyFor(body);
  const config = readWhisperConfig(process.env);
  const tmpDir = join(tmpdir(), `whisper-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });

  const inputExt = extensionOf(audioKey) || '.opus';
  const inputPath = join(tmpDir, `${recordingId}${inputExt}`);
  const outputPrefix = join(tmpDir, recordingId);

  try {
    await downloadFromS3(RECORDINGS_BUCKET, audioKey, inputPath);

    const result = await runWhisper({
      inputPath,
      outputPrefix,
      language: config.language,
      threads: config.threads,
      whisperBinary: config.whisperBinary,
      modelPath: config.modelPath,
    });

    const transcriptJson = await readFile(result.jsonOutputPath, 'utf8');
    const transcriptText = extractTranscriptText(transcriptJson);

    // Stage the raw whisper JSON for future word-timestamp use.
    await s3.send(
      new PutObjectCommand({
        Bucket: RECORDINGS_BUCKET,
        Key: `${PIPELINE_TEMP_PREFIX}/${recordingId}/whisper.json`,
        Body: transcriptJson,
        ContentType: 'application/json',
      }),
    );

    // Write transcript onto the Recording row + advance status.
    const ts = new Date().toISOString();
    await ddb.send(
      new UpdateItemCommand({
        TableName: RECORDING_TABLE_NAME,
        Key: marshall({ id: recordingId }),
        UpdateExpression: 'SET #t = :t, #ts = :ts, #tsu = :tsu',
        ExpressionAttributeNames: {
          '#t': 'transcript',
          '#ts': 'transcriptionStatus',
          '#tsu': 'transcriptionStatusUpdatedAt',
        },
        ExpressionAttributeValues: marshall({
          ':t': transcriptText,
          ':ts': 'PARSING',
          ':tsu': ts,
        }),
      }),
    );

    // Publish onto the linguistic queue.
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: LINGUISTIC_QUEUE_URL,
        MessageBody: JSON.stringify({
          recordingId,
          transcript: transcriptText,
          enqueuedAt: ts,
        }),
      }),
    );

    console.info('whisper-handler: advanced to PARSING', {
      recordingId,
      transcriptLen: transcriptText.length,
      stderrTail: result.stderrTail.slice(-256),
    });
  } catch (err) {
    if (err instanceof WhisperError) {
      console.error('whisper-handler: whisper.cpp failed', {
        recordingId,
        code: err.code,
        stderr: err.stderr.slice(-1024),
      });
    } else {
      console.error('whisper-handler: unexpected failure', {
        recordingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    await Promise.allSettled([
      unlink(inputPath).catch(() => undefined),
      unlink(`${outputPrefix}.json`).catch(() => undefined),
    ]);
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
