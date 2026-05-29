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
  deleteSpy: ReturnType<typeof vi.fn>;
}

function makeDataStub(): DataStub {
  const createSpy = vi.fn().mockResolvedValue({ data: { id: 'msg-uuid-1' }, errors: null });
  const updateSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  const deleteSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  const client: LinguisticDataClient = {
    models: {
      Message: { create: createSpy as never, delete: deleteSpy as never },
      Recording: { update: updateSpy as never },
    },
  };
  return { client, createSpy, updateSpy, deleteSpy };
}

/** Amplify Data shape for a `.update()` against a deleted row. */
const CONDITIONAL_CHECK_ERRORS = [
  {
    errorType: 'DynamoDB:ConditionalCheckFailedException',
    message: 'The conditional request failed',
  },
];

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
    expect(() => parseMessage(JSON.stringify({ transcript: 'x' }))).toThrow(/recordingId/);
  });

  it('rejects transcript body missing transcript field', () => {
    expect(() => parseMessage(JSON.stringify({ recordingId: 'r' }))).toThrow(/transcript/);
  });

  it('round-trips a valid transcript body', () => {
    const out = parseMessage(
      JSON.stringify({
        kind: 'transcript',
        recordingId: 'r-1',
        transcript: 'skyking skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    expect(out.kind).toBe('transcript');
    expect(out.recordingId).toBe('r-1');
    if (out.kind === 'transcript') {
      expect(out.transcript).toBe('skyking skyking');
    }
  });

  it('treats a body without `kind` as transcript for back-compat (#452)', () => {
    const out = parseMessage(
      JSON.stringify({
        recordingId: 'r-1',
        transcript: 'skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    expect(out.kind).toBe('transcript');
  });

  it('round-trips a valid transcribe-failure body (#452)', () => {
    const out = parseMessage(
      JSON.stringify({
        kind: 'transcribe-failure',
        recordingId: 'r-fail',
        reason: 'whisper.cpp exit 127: bad input file',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    expect(out.kind).toBe('transcribe-failure');
    if (out.kind === 'transcribe-failure') {
      expect(out.reason).toBe('whisper.cpp exit 127: bad input file');
    }
  });

  it('rejects transcribe-failure body missing reason (#452)', () => {
    expect(() =>
      parseMessage(JSON.stringify({ kind: 'transcribe-failure', recordingId: 'r-fail' })),
    ).toThrow(/reason/);
  });

  it('round-trips a transcript body carrying wordTimestampsKey (#92)', () => {
    const out = parseMessage(
      JSON.stringify({
        kind: 'transcript',
        recordingId: 'r-1',
        transcript: 'skyking',
        wordTimestampsKey: 'recordings/web/r-1.words.json',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    expect(out.kind).toBe('transcript');
    if (out.kind === 'transcript') {
      expect(out.wordTimestampsKey).toBe('recordings/web/r-1.words.json');
    }
  });

  it('drops empty wordTimestampsKey field (#92)', () => {
    const out = parseMessage(
      JSON.stringify({
        kind: 'transcript',
        recordingId: 'r-1',
        transcript: 'skyking',
        wordTimestampsKey: '',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    if (out.kind === 'transcript') {
      expect(out.wordTimestampsKey).toBeUndefined();
    }
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
        transcript: 'Skyking, Skyking, do not answer',
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

describe('linguistic — structured Message via normalizeParsed (#506)', () => {
  it('populates decoded body + extracted sender/receiver for ALLSTATIONS', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-as-1',
    });
    const transcript =
      'All stations all stations FOR ICEMAN FOR ICEMAN alpha charlie delta this is mainsail out';
    await handler(
      makeEvent({ recordingId: 'rec-as', transcript, enqueuedAt: '2026-05-24T18:00:00Z' }),
      {} as never,
      () => undefined,
    );

    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: 'ALLSTATIONS',
        body: 'ACD',
        sender: 'mainsail',
        receiver: 'ICEMAN',
      }),
    );
    // Recording keeps the RAW transcript — Recording is source of truth.
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 'rec-as', transcript }),
    );
  });

  it('falls back to the raw transcript when an ALLSTATIONS body has no decodable letters', async () => {
    const { client, createSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-as-empty',
    });
    const transcript = 'all stations all stations nothing decodable here';
    await handler(
      makeEvent({ recordingId: 'rec-as-e', transcript, enqueuedAt: '2026-05-24T18:00:00Z' }),
      {} as never,
      () => undefined,
    );
    const arg = createSpy.mock.calls[0]?.[0] as { type: string; body?: string };
    expect(arg.type).toBe('ALLSTATIONS');
    // decodePhonetic → "" → fall back to raw transcript, not empty body.
    expect(arg.body).toBe(transcript);
  });

  it('passes through body for OTHER (no decode) and leaves sender/receiver unset', async () => {
    const { client, createSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-other-1',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-o',
        transcript: 'some freeform note',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const arg = createSpy.mock.calls[0]?.[0] as { type: string; body?: string; sender?: string };
    expect(arg.type).toBe('OTHER');
    expect(arg.body).toBe('some freeform note');
    expect(arg.sender).toBeUndefined();
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

describe('linguistic — transcribe-failure path (#452)', () => {
  it('marks Recording TRANSCRIBE_FAILED via Amplify Data', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const event = makeEvent({
      kind: 'transcribe-failure',
      recordingId: 'rec-fail',
      reason: 'whisper.cpp exit 127: bad input file',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });
    await handler(event, {} as never, () => undefined);

    // Routes through Amplify Data so the portal subscription fires.
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-fail',
        transcriptionStatus: 'TRANSCRIBE_FAILED',
        transcriptionFailed: true,
        failedReason: 'whisper.cpp exit 127: bad input file',
      }),
    );
    // No Message created on failure paths.
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('does NOT overwrite TRANSCRIBE_FAILED with PARSE_FAILED when the linguistic-side update itself errors', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    updateSpy.mockResolvedValueOnce({
      data: null,
      errors: [{ message: 'throughput' }],
    });
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const event = makeEvent({
      kind: 'transcribe-failure',
      recordingId: 'rec-fail-2',
      reason: 'whisper.cpp exit 127',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(/throughput/);
    // Only the failed TRANSCRIBE_FAILED write — no follow-up
    // PARSE_FAILED would be wrong because that's a *parser* failure,
    // not what happened here.
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(createSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('linguistic — deleted-Recording tombstone (#459)', () => {
  it('drops a transcript message cleanly when the Recording was deleted in flight', async () => {
    const { client, updateSpy, deleteSpy } = makeDataStub();
    updateSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-orphan-1',
    });
    const event = makeEvent({
      recordingId: 'rec-deleted',
      transcript: 'skyking skyking',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // No throw → SQS deletes the message instead of redriving.
    await expect(handler(event, {} as never, () => undefined)).resolves.not.toThrow();

    // The Recording.update tombstone is the only update — no follow-up
    // PARSE_FAILED mark (the row is gone, nothing to mark).
    expect(updateSpy).toHaveBeenCalledOnce();
    // The orphan Message created moments before is cleaned up so it
    // never surfaces in the public feed without a Recording.
    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy.mock.calls[0]?.[0]).toEqual({ id: 'msg-uuid-1' });
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('still drops the message cleanly when orphan-Message cleanup fails', async () => {
    const { client, updateSpy, deleteSpy } = makeDataStub();
    updateSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    // Cleanup throws — must NOT cause a redrive (would loop, re-creating
    // a fresh orphan Message each attempt).
    deleteSpy.mockRejectedValueOnce(new Error('throughput exceeded'));
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-orphan-2',
    });
    const event = makeEvent({
      recordingId: 'rec-deleted-3',
      transcript: 'skyking skyking',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handler(event, {} as never, () => undefined)).resolves.not.toThrow();
    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('drops a transcribe-failure message cleanly when the Recording was deleted in flight', async () => {
    const { client, createSpy, updateSpy, deleteSpy } = makeDataStub();
    updateSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const event = makeEvent({
      kind: 'transcribe-failure',
      recordingId: 'rec-deleted-2',
      reason: 'whisper.cpp exit 127',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(handler(event, {} as never, () => undefined)).resolves.not.toThrow();

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(createSpy).not.toHaveBeenCalled();
    // Nothing to delete — no Message is created on the failure path.
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('still throws + redrives on a genuine (non-tombstone) Recording.update error', async () => {
    const { client, updateSpy } = makeDataStub();
    updateSpy
      // first call: the PUBLISHED write fails with a real error
      .mockResolvedValueOnce({ data: null, errors: [{ message: 'throughput exceeded' }] })
      // second call: the PARSE_FAILED mark
      .mockResolvedValueOnce({ data: {}, errors: null });
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-real',
    });
    const event = makeEvent({
      recordingId: 'rec-real-fail',
      transcript: 'skyking',
      enqueuedAt: '2026-05-24T18:00:00Z',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(event, {} as never, () => undefined)).rejects.toThrow(/throughput/);
    errSpy.mockRestore();
  });
});
