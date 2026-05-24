import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

import { handler, classify, parseMessage, __setDeps, __resetDeps } from './handler';

/**
 * Linguistic Lambda contract (#433 stage 4):
 *
 *   SQS message → classify → DDB PutItem(Message) → DDB UpdateItem(Recording → PUBLISHED)
 */

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
  ddbMock.reset();
  process.env.RECORDING_TABLE_NAME = 'Recording-test-NONE';
  process.env.MESSAGE_TABLE_NAME = 'Message-test-NONE';
  ddbMock.on(PutItemCommand).resolves({});
  ddbMock.on(UpdateItemCommand).resolves({});
  __setDeps({
    ddb: new DynamoDBClient({}),
    now: () => new Date('2026-05-24T18:00:00Z'),
    uuid: () => 'msg-uuid-1',
  });
});

afterEach(() => {
  __resetDeps();
});

describe('linguistic — classify', () => {
  it('matches SKYKING preamble', () => {
    const r = classify('Skyking, Skyking, do not answer. Bears time 14. Authentication 9D.');
    expect(r.type).toBe('SKYKING');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('matches ALLSTATIONS', () => {
    const r = classify('All stations, all stations, this is Mainsail with a Foxtrot message.');
    expect(r.type).toBe('ALLSTATIONS');
  });

  it('matches RADIOCHECK (radio check)', () => {
    expect(classify('Cape Radio, this is Mainsail, radio check, over').type).toBe('RADIOCHECK');
  });

  it('matches RADIOCHECK (test count)', () => {
    expect(classify('This is Mainsail with a test count, testing 1 2 3 4 5').type).toBe(
      'RADIOCHECK',
    );
  });

  it('matches SKYBIRD', () => {
    expect(classify('Skybird, this is Offutt').type).toBe('SKYBIRD');
  });

  it('matches SKYMASTER', () => {
    expect(classify('Skymaster, this is Andrews').type).toBe('SKYMASTER');
  });

  it('matches DISREGARDED', () => {
    expect(classify('Mainsail, disregard previous transmission, disregard').type).toBe(
      'DISREGARDED',
    );
  });

  it('falls back to OTHER for unrecognised text', () => {
    expect(classify('Hello world, just a regular sentence').type).toBe('OTHER');
  });

  it('returns OTHER for empty transcript', () => {
    expect(classify('').type).toBe('OTHER');
  });

  it('SKYKING beats ALL STATIONS when both appear', () => {
    expect(classify('All stations, this is Mainsail; skyking, skyking').type).toBe('SKYKING');
  });
});

describe('linguistic — parseMessage', () => {
  it('rejects body missing recordingId', () => {
    expect(() => parseMessage(JSON.stringify({ transcript: 'x' }))).toThrow(
      /missing required fields/,
    );
  });

  it('rejects body missing transcript', () => {
    expect(() => parseMessage(JSON.stringify({ recordingId: 'r' }))).toThrow(
      /missing required fields/,
    );
  });

  it('round-trips a valid body', () => {
    const out = parseMessage(
      JSON.stringify({
        recordingId: 'r-1',
        transcript: 'skyking skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    expect(out.recordingId).toBe('r-1');
    expect(out.transcript).toBe('skyking skyking');
  });
});

describe('linguistic — handler happy path', () => {
  it('creates Message + advances Recording to PUBLISHED', async () => {
    const event = makeEvent({
      recordingId: 'rec-1',
      transcript: 'Skyking, Skyking, do not answer',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });
    await handler(event, {} as never, () => undefined);

    const puts = ddbMock.commandCalls(PutItemCommand);
    expect(puts).toHaveLength(1);
    const putInput = puts[0]?.args[0].input;
    expect(putInput?.TableName).toBe('Message-test-NONE');

    // Pin every field the Amplify Gen 2 Message model expects so a
    // future schema drift (rename, .required() addition, etc.) trips
    // here instead of at AppSync read time. broadcastTs is
    // `.required()` on the model — its absence on the PutItem was
    // the original review finding that led to this rewrite.
    const item = putInput?.Item ?? {};
    expect(item.id).toEqual({ S: 'msg-uuid-1' });
    expect(item.type).toEqual({ S: 'SKYKING' });
    expect(item.broadcastTs).toEqual({ S: '2026-05-24T17:55:00Z' });
    expect(item.body).toEqual({ S: 'Skyking, Skyking, do not answer' });
    expect(item.confidence).toEqual({ N: '0.85' });
    expect(item.flaggedForReview).toEqual({ BOOL: false });
    expect(item.publishedAt).toEqual({ S: '2026-05-24T18:00:00.000Z' });
    expect(item.__typename).toEqual({ S: 'Message' });

    const updates = ddbMock.commandCalls(UpdateItemCommand);
    expect(updates).toHaveLength(1);
    const updateInput = updates[0]?.args[0].input;
    expect(updateInput?.TableName).toBe('Recording-test-NONE');
    expect(updateInput?.UpdateExpression).toContain('#mid');
    expect(updateInput?.ExpressionAttributeValues?.[':mid']).toEqual({
      S: 'msg-uuid-1',
    });
    expect(updateInput?.ExpressionAttributeValues?.[':ts']).toEqual({
      S: 'PUBLISHED',
    });
  });

  it('flags low-confidence Messages for review', async () => {
    const event = makeEvent({
      recordingId: 'rec-2',
      transcript: 'unknown noise',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    await handler(event, {} as never, () => undefined);
    const puts = ddbMock.commandCalls(PutItemCommand);
    expect(puts[0]?.args[0].input.Item?.flaggedForReview).toEqual({
      BOOL: true,
    });
  });
});

describe('linguistic — failure paths', () => {
  it('skips malformed SQS bodies', async () => {
    const event: SQSEvent = {
      Records: [
        {
          body: '{nope',
          messageId: 'm',
          receiptHandle: 'r',
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

  it('rethrows when DDB PutItem fails', async () => {
    ddbMock.on(PutItemCommand).rejects(new Error('throughput exceeded'));
    const event = makeEvent({
      recordingId: 'rec-x',
      transcript: 'skyking',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(/throughput/);
    errSpy.mockRestore();
  });
});
