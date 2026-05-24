import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

import {
  handler,
  buildWebKey,
  parseMessage,
  __setDeps,
  __resetDeps,
  type PreprocessDataClient,
} from './handler';

/**
 * Pre-process Lambda contract (#433 stage 2):
 *
 *   SQS message → HEAD original → COPY to web key →
 *     Amplify Data `Recording.update(status=TRANSCRIBING)` →
 *     SQS publish on the transcribe queue
 *
 *   on failure → `Recording.update(status=PREPROCESS_FAILED, failedReason=…)`
 *     before rethrow so SQS redrives + the portal/admin see the
 *     stuck row.
 *
 * Tests inject mocked SDK clients + a stub data client so the
 * handler is exercised end-to-end without real AWS calls.
 */

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);

function makeEvent(body: object): SQSEvent {
  return {
    Records: [
      {
        body: JSON.stringify(body),
        messageId: 'm-1',
        receiptHandle: 'r-1',
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1',
          SenderId: 's',
          ApproximateFirstReceiveTimestamp: '1',
        },
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

interface DataStub {
  client: PreprocessDataClient;
  updateSpy: ReturnType<typeof vi.fn>;
}

function makeDataStub(): DataStub {
  const updateSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  const client: PreprocessDataClient = {
    models: {
      Recording: {
        update: updateSpy as never,
      },
    },
  };
  return { client, updateSpy };
}

beforeEach(() => {
  s3Mock.reset();
  sqsMock.reset();
  process.env.RECORDINGS_BUCKET = 'test-bucket';
  process.env.TRANSCRIBE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/0/transcribe';

  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1234 });
  s3Mock.on(CopyObjectCommand).resolves({});
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-1' });
});

afterEach(() => {
  __resetDeps();
});

describe('preprocess — helpers', () => {
  it('buildWebKey preserves the original extension', () => {
    expect(buildWebKey('rec-1', 'recordings/originals/abc.wav')).toBe('recordings/web/rec-1.wav');
    expect(buildWebKey('rec-2', 'recordings/originals/abc.mp3')).toBe('recordings/web/rec-2.mp3');
    expect(buildWebKey('rec-3', 'recordings/originals/abc')).toBe('recordings/web/rec-3');
  });

  it('parseMessage rejects messages missing required fields', () => {
    expect(() => parseMessage('{}')).toThrow(/missing required fields/);
    expect(() => parseMessage(JSON.stringify({ recordingId: 'r', originalKey: 'k' }))).toThrow(
      /missing required fields/,
    );
  });

  it('parseMessage round-trips a valid message', () => {
    const out = parseMessage(
      JSON.stringify({
        recordingId: 'rec-1',
        originalKey: 'recordings/originals/x.wav',
        contentHash: 'hash',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    expect(out.recordingId).toBe('rec-1');
    expect(out.contentHash).toBe('hash');
  });
});

describe('preprocess — happy path', () => {
  it('copies the original to the web key, advances Recording via Amplify Data, publishes transcribe message', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      s3: new S3Client({}),
      sqs: new SQSClient({}),
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const event = makeEvent({
      recordingId: 'rec-42',
      originalKey: 'recordings/originals/abc.wav',
      contentHash: 'h-42',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });

    await handler(event, {} as never, () => undefined);

    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls).toHaveLength(1);
    expect(copyCalls[0]?.args[0].input.Key).toBe('recordings/web/rec-42.wav');
    expect(copyCalls[0]?.args[0].input.CopySource).toBe(
      'test-bucket/recordings%2Foriginals%2Fabc.wav',
    );

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-42',
        webCanonicalKey: 'recordings/web/rec-42.wav',
        canonicalSizeBytes: 1234,
        transcriptionStatus: 'TRANSCRIBING',
        transcriptionStatusUpdatedAt: '2026-05-24T18:00:00.000Z',
      }),
    );

    const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
    expect(sqsCalls).toHaveLength(1);
    const sentBody = JSON.parse(sqsCalls[0]?.args[0].input.MessageBody ?? '{}') as {
      recordingId: string;
      audioKey: string;
    };
    expect(sentBody.recordingId).toBe('rec-42');
    expect(sentBody.audioKey).toBe('recordings/web/rec-42.wav');
  });

  it('URL-encodes only the key portion of CopySource — preserves the bucket/slash delimiter', async () => {
    const { client } = makeDataStub();
    __setDeps({
      s3: new S3Client({}),
      sqs: new SQSClient({}),
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const event = makeEvent({
      recordingId: 'rec-encode',
      originalKey: 'recordings/originals/hash (1).wav',
      contentHash: 'h-encode',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });
    await handler(event, {} as never, () => undefined);
    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls[0]?.args[0].input.CopySource).toBe(
      'test-bucket/recordings%2Foriginals%2Fhash%20(1).wav',
    );
  });
});

describe('preprocess — failure paths', () => {
  it('skips a malformed SQS body without throwing', async () => {
    const { client } = makeDataStub();
    __setDeps({
      s3: new S3Client({}),
      sqs: new SQSClient({}),
      dataClient: client,
    });
    const event: SQSEvent = {
      Records: [
        {
          body: '{not json}',
          messageId: 'm-1',
          receiptHandle: 'r-1',
          attributes: {
            ApproximateReceiveCount: '1',
            SentTimestamp: '1',
            SenderId: 's',
            ApproximateFirstReceiveTimestamp: '1',
          },
          messageAttributes: {},
          md5OfBody: '',
          eventSource: 'aws:sqs',
          eventSourceARN: 'arn',
          awsRegion: 'us-east-1',
        },
      ],
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('marks Recording PREPROCESS_FAILED + rethrows when CopyObject fails', async () => {
    s3Mock.on(CopyObjectCommand).rejects(new Error('AccessDenied'));
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      s3: new S3Client({}),
      sqs: new SQSClient({}),
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const event = makeEvent({
      recordingId: 'rec-fail',
      originalKey: 'recordings/originals/x.wav',
      contentHash: 'h',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(/AccessDenied/);
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-fail',
        transcriptionStatus: 'PREPROCESS_FAILED',
        transcriptionFailed: true,
        failedReason: 'AccessDenied',
      }),
    );
    errSpy.mockRestore();
  });
});
