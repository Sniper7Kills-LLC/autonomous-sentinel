import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

import {
  handler,
  classify,
  parseMessage,
  __setDeps,
  __resetDeps,
  type LinguisticDataClient,
} from './handler';

/**
 * Linguistic Lambda contract (#433 stage 4):
 *
 *   SQS message → classify → Message.create →
 *     Recording.update(status=PUBLISHED, messageId=…)
 *
 *   on failure → Recording.update(status=PARSE_FAILED, failedReason=…)
 *     before rethrow.
 *
 * Both writes go through the Amplify Data client so AppSync's
 * subscription publisher fires for the testing portal.
 */

interface DataStub {
  client: LinguisticDataClient;
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
}

function makeDataStub(): DataStub {
  const createSpy = vi.fn().mockResolvedValue({ data: { id: 'msg-uuid-1' }, errors: null });
  const updateSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  const client: LinguisticDataClient = {
    models: {
      Message: { create: createSpy as never },
      Recording: { update: updateSpy as never },
    },
  };
  return { client, createSpy, updateSpy };
}

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
  it('creates Message via Amplify Data + advances Recording to PUBLISHED', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-1',
    });
    const event = makeEvent({
      recordingId: 'rec-1',
      transcript: 'Skyking, Skyking, do not answer',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });
    await handler(event, {} as never, () => undefined);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'msg-uuid-1',
        type: 'SKYKING',
        broadcastTs: '2026-05-24T17:55:00Z',
        body: 'Skyking, Skyking, do not answer',
        confidence: 0.85,
        flaggedForReview: false,
        publishedAt: '2026-05-24T18:00:00.000Z',
      }),
    );

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-1',
        messageId: 'msg-uuid-1',
        transcriptionStatus: 'PUBLISHED',
      }),
    );
  });

  it('flags low-confidence Messages for review', async () => {
    const { client, createSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-2',
    });
    const event = makeEvent({
      recordingId: 'rec-2',
      transcript: 'unknown noise',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    await handler(event, {} as never, () => undefined);
    expect((createSpy.mock.calls[0]?.[0] as { flaggedForReview?: boolean })?.flaggedForReview).toBe(
      true,
    );
  });
});

describe('linguistic — failure paths', () => {
  it('skips malformed SQS bodies', async () => {
    const { client } = makeDataStub();
    __setDeps({ dataClient: client });
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

  it('marks Recording PARSE_FAILED + rethrows when Message.create errors', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    createSpy.mockResolvedValueOnce({
      data: null,
      errors: [{ message: 'throughput' }],
    });
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-x',
    });
    const event = makeEvent({
      recordingId: 'rec-x',
      transcript: 'skyking',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(/throughput/);
    // updateSpy is called once — for the PARSE_FAILED mark.
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-x',
        transcriptionStatus: 'PARSE_FAILED',
        transcriptionFailed: true,
      }),
    );
    errSpy.mockRestore();
  });
});
