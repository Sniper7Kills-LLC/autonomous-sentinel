import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

import {
  handler,
  parseMessage,
  __setDeps,
  __resetDeps,
  type PreprocessDataClient,
} from './handler';

/**
 * Pre-process Lambda contract (#433 stage 2 / consolidated #514):
 *
 *   SQS message → HEAD original (validate) →
 *     Amplify Data `Recording.update(status=TRANSCRIBING)` →
 *     SQS publish `{recordingId, originalKey, contentHash}` on the
 *     transcribe queue (the Whisper container does the ffmpeg transcode)
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
  getSpy: ReturnType<typeof vi.fn>;
}

function makeDataStub(currentStatus: string = 'QUEUED'): DataStub {
  const updateSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  // #741: the stage reads current status first to guard against regressing
  // an already-advanced recording. Default to QUEUED (a fresh upload).
  const getSpy = vi
    .fn()
    .mockResolvedValue({ data: { id: 'rec', transcriptionStatus: currentStatus }, errors: null });
  const client: PreprocessDataClient = {
    models: {
      Recording: {
        get: getSpy as never,
        update: updateSpy as never,
      },
    },
  };
  return { client, updateSpy, getSpy };
}

beforeEach(() => {
  s3Mock.reset();
  sqsMock.reset();
  process.env.RECORDINGS_BUCKET = 'test-bucket';
  process.env.TRANSCRIBE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/0/transcribe';

  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1234 });
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-1' });
});

afterEach(() => {
  __resetDeps();
});

describe('preprocess — helpers', () => {
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

describe('preprocess — happy path (consolidated #514)', () => {
  it('validates the original, advances Recording to TRANSCRIBING, publishes originalKey to transcribe', async () => {
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

    // HEAD validates existence; no copy/transcode in preprocess anymore.
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(1);

    // Status advances QUEUED → PREPROCESSING (on pickup) → TRANSCRIBING
    // (on handoff); webCanonicalKey is NOT set here (the container sets it later).
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 'rec-42', transcriptionStatus: 'PREPROCESSING' }),
    );
    const upd = updateSpy.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(upd).toEqual(
      expect.objectContaining({
        id: 'rec-42',
        transcriptionStatus: 'TRANSCRIBING',
        transcriptionStatusUpdatedAt: '2026-05-24T18:00:00.000Z',
      }),
    );
    expect(upd.webCanonicalKey).toBeUndefined();

    // Transcribe message carries the ORIGINAL key + contentHash.
    const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
    expect(sqsCalls).toHaveLength(1);
    const sentBody = JSON.parse(sqsCalls[0]?.args[0].input.MessageBody ?? '{}') as {
      recordingId: string;
      originalKey: string;
      contentHash: string;
    };
    expect(sentBody.recordingId).toBe('rec-42');
    expect(sentBody.originalKey).toBe('recordings/originals/abc.wav');
    expect(sentBody.contentHash).toBe('h-42');
  });

  it('skips (no status write, no transcribe enqueue) when the recording already reached TRANSCRIBING (#741)', async () => {
    const { client, updateSpy } = makeDataStub('PUBLISHED');
    __setDeps({
      s3: new S3Client({}),
      sqs: new SQSClient({}),
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const event = makeEvent({
      recordingId: 'rec-dup',
      originalKey: 'recordings/originals/abc.wav',
      contentHash: 'h',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });

    await handler(event, {} as never, () => undefined);

    // No status regression, no HEAD, no re-enqueue to transcribe.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it('forwards a backendOverride onto the transcribe message (#592)', async () => {
    const { client } = makeDataStub();
    __setDeps({
      s3: new S3Client({}),
      sqs: new SQSClient({}),
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec-99',
        originalKey: 'recordings/originals/x.wav',
        contentHash: 'h-99',
        enqueuedAt: '2026-05-24T17:55:00Z',
        backendOverride: 'amazon-transcribe',
      }),
      {} as never,
      () => undefined,
    );
    const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
    const sentBody = JSON.parse(sqsCalls[0]?.args[0].input.MessageBody ?? '{}') as {
      backendOverride?: string;
    };
    expect(sentBody.backendOverride).toBe('amazon-transcribe');
  });

  it('omits backendOverride from the transcribe message on a normal upload (#592)', async () => {
    const { client } = makeDataStub();
    __setDeps({
      s3: new S3Client({}),
      sqs: new SQSClient({}),
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec-100',
        originalKey: 'recordings/originals/x.wav',
        contentHash: 'h-100',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
    const sentBody = JSON.parse(sqsCalls[0]?.args[0].input.MessageBody ?? '{}') as Record<
      string,
      unknown
    >;
    expect(sentBody).not.toHaveProperty('backendOverride');
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

  it('marks Recording PREPROCESS_FAILED + rethrows when the original HEAD fails', async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error('AccessDenied'));
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
    // PREPROCESSING write on pickup (calls[0]), then PREPROCESS_FAILED after HEAD fails (calls[1]).
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 'rec-fail', transcriptionStatus: 'PREPROCESSING' }),
    );
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
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
