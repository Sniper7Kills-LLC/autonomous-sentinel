/**
 * Whisper container Lambda handler (#54).
 *
 * Runs INSIDE the container image (`Dockerfile`); the build copies
 * this file as `${LAMBDA_TASK_ROOT}/handler.mjs`. Container Lambda
 * `CMD ["handler.handler"]` points the runtime here.
 *
 * Per SQS message (one Recording per invoke per `batchSize: 1`):
 *   1. Download `recordings/web/<id>.opus` from S3 to /tmp.
 *   2. Run `/opt/whisper` against the medium English model.
 *   3. Read the `<id>.json` whisper.cpp output.
 *   4. Persist transcript onto the Recording row (deferred — the
 *      DDB update path needs Amplify's data client. v1 stages
 *      the JSON in `pipeline-temp/` and emits an EventBridge
 *      event for a follow-up finalizer Lambda).
 *   5. Clean up /tmp.
 *
 * Failure: any throw fails the SQS batch (`batchSize=1` so one
 * Recording per message); SQS redrives per the queue's
 * `maxReceiveCount`, then lands on the transcribe DLQ from #67.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWhisperConfig, runWhisper, WhisperError } from './run-whisper.mjs';

const RECORDINGS_BUCKET = process.env.RECORDINGS_BUCKET ?? '';
const PIPELINE_TEMP_PREFIX = process.env.PIPELINE_TEMP_PREFIX ?? 'pipeline-temp';

const s3 = new S3Client({});

export async function handler(event) {
  if (!RECORDINGS_BUCKET) {
    throw new Error('whisper-handler: RECORDINGS_BUCKET env var is unset');
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
    console.error('whisper-handler: invalid SQS body JSON', { error: String(err) });
    return null;
  }
}

async function processOne({ recordingId }) {
  if (!recordingId || typeof recordingId !== 'string') {
    throw new Error('whisper-handler: SQS body missing recordingId');
  }
  const config = readWhisperConfig(process.env);
  const tmpDir = join(tmpdir(), `whisper-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });

  const inputPath = join(tmpDir, `${recordingId}.opus`);
  const outputPrefix = join(tmpDir, recordingId);

  try {
    await downloadFromS3(RECORDINGS_BUCKET, `recordings/web/${recordingId}.opus`, inputPath);

    const result = await runWhisper({
      inputPath,
      outputPrefix,
      language: config.language,
      threads: config.threads,
      whisperBinary: config.whisperBinary,
      modelPath: config.modelPath,
    });

    const transcriptJson = await readFile(result.jsonOutputPath, 'utf8');

    // Stage the transcript in pipeline-temp/ for a follow-up
    // finalizer Lambda to ingest into the Recording row. Keeps
    // this Lambda dependency-free of Amplify Data client + the
    // DDB schema.
    await s3.send(
      new PutObjectCommand({
        Bucket: RECORDINGS_BUCKET,
        Key: `${PIPELINE_TEMP_PREFIX}/${recordingId}/whisper.json`,
        Body: transcriptJson,
        ContentType: 'application/json',
      }),
    );

    console.info('whisper-handler: transcribed', {
      recordingId,
      jsonBytes: transcriptJson.length,
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

async function downloadFromS3(bucket, key, destPath) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`whisper-handler: empty S3 body for s3://${bucket}/${key}`);
  }
  await pipeline(response.Body, createWriteStream(destPath));
}
