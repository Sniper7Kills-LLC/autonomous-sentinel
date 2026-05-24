import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

import { handler, buildWebKey, parseMessage, __setDeps, __resetDeps } from './handler';

/**
 * Pre-process Lambda contract (#433 stage 2):
 *
 *   SQS message → HEAD original → COPY to web key → DDB UpdateItem
 *     (status TRANSCRIBING) → SQS publish on the transcribe queue
 *
 * Tests inject mocked SDK clients so the handler can be exercised
 * end-to-end without real AWS calls.
 */

const s3Mock = mockClient(S3Client);
const sqsMock = mockClient(SQSClient);
const ddbMock = mockClient(DynamoDBClient);

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

beforeEach(() => {
  s3Mock.reset();
  sqsMock.reset();
  ddbMock.reset();
  process.env.RECORDINGS_BUCKET = 'test-bucket';
  process.env.RECORDING_TABLE_NAME = 'Recording-test-NONE';
  process.env.TRANSCRIBE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/0/transcribe';

  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1234 });
  s3Mock.on(CopyObjectCommand).resolves({});
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'sqs-1' });
  ddbMock.on(UpdateItemCommand).resolves({});

  __setDeps({
    s3: new S3Client({}),
    sqs: new SQSClient({}),
    ddb: new DynamoDBClient({}),
    now: () => new Date('2026-05-24T18:00:00Z'),
  });
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
  it('copies the original to the web key, updates Recording, publishes transcribe message', async () => {
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
    // CopySource must be `bucket/<url-encoded-key>` — the slash
    // delimiter must NOT be encoded. Pin the full string so a
    // future regression on the encoding (the original PR encoded
    // the whole thing including the delimiter, which AWS rejects)
    // fails the test.
    expect(copyCalls[0]?.args[0].input.CopySource).toBe(
      'test-bucket/recordings%2Foriginals%2Fabc.wav',
    );

    const ddbCalls = ddbMock.commandCalls(UpdateItemCommand);
    expect(ddbCalls).toHaveLength(1);
    const updateInput = ddbCalls[0]?.args[0].input;
    expect(updateInput?.TableName).toBe('Recording-test-NONE');
    expect(updateInput?.UpdateExpression).toMatch(/transcriptionStatus|#ts/);

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
    // Key with characters that need encoding (space, parentheses).
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

  it('rethrows when CopyObject fails so SQS redrives the message', async () => {
    s3Mock.on(CopyObjectCommand).rejects(new Error('AccessDenied'));
    const event = makeEvent({
      recordingId: 'rec-fail',
      originalKey: 'recordings/originals/x.wav',
      contentHash: 'h',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(/AccessDenied/);
    errSpy.mockRestore();
  });
});
