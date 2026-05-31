import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { handler, parseJobStateEvent, __resetDeps } from './handler';
import { buildJobName } from '../transcribe-aws/job-name';

/**
 * transcribe-aws-finalizer contract (#585):
 *
 *   EventBridge `aws.transcribe` "Transcribe Job State Change" →
 *     recover recordingId from the job name →
 *       COMPLETED: GetObject output JSON → parseTranscribeResult →
 *         mean per-word confidence → SendMessage `{kind:'transcript',
 *         recordingId, transcript, transcriptionConfidence, enqueuedAt}`
 *       FAILED: SendMessage `{kind:'transcribe-failure', recordingId, reason}`
 *       bad/missing job name → no-op (no throw — EventBridge retries forever)
 */

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);

const ENV = {
  RECORDINGS_BUCKET: 'media-bucket',
  PIPELINE_TEMP_PREFIX: 'pipeline-temp',
  LINGUISTIC_QUEUE_URL: 'https://sqs/linguistic',
};

beforeEach(() => {
  s3Mock.reset();
  sqsMock.reset();
  __resetDeps();
  process.env.RECORDINGS_BUCKET = ENV.RECORDINGS_BUCKET;
  process.env.PIPELINE_TEMP_PREFIX = ENV.PIPELINE_TEMP_PREFIX;
  process.env.LINGUISTIC_QUEUE_URL = ENV.LINGUISTIC_QUEUE_URL;
});

interface LinguisticMessage {
  kind: string;
  recordingId: string;
  backend?: string;
  transcript?: string;
  transcriptionConfidence?: number;
  reason?: string;
  enqueuedAt?: string;
}

function s3Body(json: object) {
  // The real S3 SDK `Body` is a stream carrying `transformToString()`.
  // The finalizer reads via that method, so the test stub provides it
  // directly — no `@smithy/util-stream` dependency needed. Cast through
  // `never` because the SDK's `Body` type is the full stream union.
  return { Body: { transformToString: () => Promise.resolve(JSON.stringify(json)) } as never };
}

/** Reads the single SQS SendMessage body as a typed linguistic message. */
function sentBody(): LinguisticMessage {
  const call = sqsMock.commandCalls(SendMessageCommand)[0];
  return JSON.parse((call?.args[0].input.MessageBody as string) ?? '{}') as LinguisticMessage;
}

function jobEvent(jobName: string, status: 'COMPLETED' | 'FAILED', failureReason?: string) {
  return {
    source: 'aws.transcribe',
    'detail-type': 'Transcribe Job State Change',
    detail: {
      TranscriptionJobName: jobName,
      TranscriptionJobStatus: status,
      ...(failureReason ? { FailureReason: failureReason } : {}),
    },
  };
}

const SAMPLE_OUTPUT = {
  jobName: 'job',
  status: 'COMPLETED',
  results: {
    transcripts: [{ transcript: 'SKYKING SKYKING DO NOT ANSWER' }],
    items: [
      {
        type: 'pronunciation',
        start_time: '0.0',
        end_time: '0.5',
        alternatives: [{ content: 'SKYKING', confidence: '0.9' }],
      },
      {
        type: 'pronunciation',
        start_time: '0.5',
        end_time: '1.0',
        alternatives: [{ content: 'SKYKING', confidence: '0.7' }],
      },
      { type: 'punctuation', alternatives: [{ content: '.', confidence: '0.0' }] },
    ],
    language_code: 'en-US',
  },
};

describe('parseJobStateEvent', () => {
  it('extracts job name + status from a Transcribe state-change event', () => {
    const parsed = parseJobStateEvent(jobEvent('eam-rec-1-1-1', 'COMPLETED'));
    expect(parsed).toEqual({ jobName: 'eam-rec-1-1-1', status: 'COMPLETED', failureReason: null });
  });

  it('returns null for an unrelated event', () => {
    expect(parseJobStateEvent({ source: 'aws.s3', detail: {} })).toBeNull();
    expect(parseJobStateEvent(null)).toBeNull();
  });
});

describe('handler — COMPLETED', () => {
  it('parses the output, aggregates confidence, and enqueues a transcript message', async () => {
    const jobName = buildJobName('rec-123', { now: () => 1, rand: () => 0 });
    s3Mock.on(GetObjectCommand).resolves(s3Body(SAMPLE_OUTPUT));
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });

    await handler(jobEvent(jobName, 'COMPLETED'));

    // Fetched from the pipeline-temp output key for this recording.
    const get = s3Mock.commandCalls(GetObjectCommand);
    expect(get).toHaveLength(1);
    expect(get[0]!.args[0].input.Bucket).toBe(ENV.RECORDINGS_BUCKET);
    expect(get[0]!.args[0].input.Key).toBe('pipeline-temp/rec-123/transcribe.json');

    const sent = sqsMock.commandCalls(SendMessageCommand);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args[0].input.QueueUrl).toBe(ENV.LINGUISTIC_QUEUE_URL);
    const body = sentBody();
    expect(body.kind).toBe('transcript');
    expect(body.recordingId).toBe('rec-123');
    // Backend label keys the per-backend transcripts collection (#593).
    expect(body.backend).toBe('amazon-transcribe');
    expect(body.transcript).toBe('SKYKING SKYKING DO NOT ANSWER');
    // mean of 0.9 and 0.7 = 0.8
    expect(body.transcriptionConfidence).toBeCloseTo(0.8, 10);
    expect(typeof body.enqueuedAt).toBe('string');
  });

  it('omits transcriptionConfidence when no per-word confidence is present', async () => {
    const jobName = buildJobName('rec-noconf', { now: () => 1, rand: () => 0 });
    s3Mock.on(GetObjectCommand).resolves(
      s3Body({
        results: {
          transcripts: [{ transcript: 'HELLO' }],
          items: [
            {
              type: 'pronunciation',
              start_time: '0.0',
              end_time: '0.5',
              alternatives: [{ content: 'HELLO' }],
            },
          ],
        },
      }),
    );
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(jobEvent(jobName, 'COMPLETED'));

    const body = sentBody();
    expect(body.kind).toBe('transcript');
    expect('transcriptionConfidence' in body).toBe(false);
  });

  it('enqueues a transcribe-failure when the output transcript is empty (silence)', async () => {
    const jobName = buildJobName('rec-silent', { now: () => 1, rand: () => 0 });
    s3Mock
      .on(GetObjectCommand)
      .resolves(s3Body({ results: { transcripts: [{ transcript: '' }], items: [] } }));
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(jobEvent(jobName, 'COMPLETED'));

    const body = sentBody();
    expect(body.kind).toBe('transcribe-failure');
    expect(body.recordingId).toBe('rec-silent');
  });
});

describe('handler — FAILED', () => {
  it('enqueues a transcribe-failure carrying the failure reason', async () => {
    const jobName = buildJobName('rec-x', { now: () => 1, rand: () => 0 });
    sqsMock.on(SendMessageCommand).resolves({});

    await handler(jobEvent(jobName, 'FAILED', 'Unsupported audio format'));

    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    const body = sentBody();
    expect(body.kind).toBe('transcribe-failure');
    expect(body.recordingId).toBe('rec-x');
    expect(body.reason).toContain('Unsupported audio format');
  });
});

describe('handler — bad input', () => {
  it('no-ops (no throw, no SQS) on a job name we cannot decode', async () => {
    await handler(jobEvent('foreign-job-name', 'COMPLETED'));
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('no-ops on an unrelated / malformed event', async () => {
    await handler({ source: 'aws.s3', detail: {} });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('ignores non-terminal states (IN_PROGRESS / QUEUED)', async () => {
    const jobName = buildJobName('rec-ip', { now: () => 1, rand: () => 0 });
    await handler({
      source: 'aws.transcribe',
      'detail-type': 'Transcribe Job State Change',
      detail: { TranscriptionJobName: jobName, TranscriptionJobStatus: 'IN_PROGRESS' },
    });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});
