import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

import {
  handler,
  classify,
  parseMessage,
  __setDeps,
  __resetDeps,
  type LinguisticDataClient,
  type RulesMatcher,
} from './handler';
import type { RuleMatch } from './rules-engine';
import { renderFallbackPrompt, type ProposedRule } from './ai-fallback';
import { hashPrompt } from './attempts';

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
  getSpy: ReturnType<typeof vi.fn>;
  listSpy: ReturnType<typeof vi.fn>;
  configGetSpy: ReturnType<typeof vi.fn>;
  promptListSpy: ReturnType<typeof vi.fn>;
  ruleCreateSpy: ReturnType<typeof vi.fn>;
}

/**
 * @param candidates Messages the dedup GSI query returns (default none).
 * @param confidenceValue `value` returned by LinguisticConfig.get for
 *   the CONFIDENCE_THRESHOLDS row (#65). Default `null` = no row, so
 *   the threshold gate falls back to the hard-coded 0.8.
 */
function makeDataStub(
  candidates: Array<{ id: string; type?: string; body?: string | null }> = [],
  confidenceValue: unknown = null,
  fallbackThresholdValue: unknown = null,
): DataStub {
  const createSpy = vi.fn().mockResolvedValue({ data: { id: 'msg-uuid-1' }, errors: null });
  const updateSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  const deleteSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  // Recording.get → no broadcastedAt (testing-portal upload) by default.
  const getSpy = vi
    .fn()
    .mockResolvedValue({ data: { id: 'rec', broadcastedAt: null }, errors: null });
  const listSpy = vi.fn().mockResolvedValue({ data: candidates, errors: null });
  const configGetSpy = vi.fn().mockImplementation((input: { key: string }) => {
    const v =
      input.key === 'FALLBACK_CONFIDENCE_THRESHOLD' ? fallbackThresholdValue : confidenceValue;
    return Promise.resolve({ data: v === null ? null : { value: v }, errors: null });
  });
  // No active prompt template by default → ai-fallback uses the bundled
  // markdown default (#self-improving-loop).
  const promptListSpy = vi.fn().mockResolvedValue({ data: [], errors: null });
  const ruleCreateSpy = vi.fn().mockResolvedValue({ data: { id: 'rule-1' }, errors: null });
  const client: LinguisticDataClient = {
    models: {
      Message: {
        create: createSpy as never,
        delete: deleteSpy as never,
        list: listSpy as never,
      },
      Recording: { get: getSpy as never, update: updateSpy as never },
      LinguisticConfig: { get: configGetSpy as never },
      LinguisticPromptTemplate: {
        list: promptListSpy as never,
      },
      LinguisticRule: { create: ruleCreateSpy as never },
    },
  };
  return {
    client,
    createSpy,
    updateSpy,
    deleteSpy,
    getSpy,
    listSpy,
    configGetSpy,
    promptListSpy,
    ruleCreateSpy,
  };
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
    // id is now a deterministic content hash (#454 dedup race guard),
    // not the injected uuid — assert the rest of the payload.
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
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

  it('uses a DDB rule match: type + captured fields thread through to Message.create (#460)', async () => {
    const { client, createSpy } = makeDataStub();
    const match: RuleMatch = {
      ruleId: 'skyking-v3',
      promptVersion: 3,
      confidence: 0.9,
      message: {
        messageType: 'SKYKING',
        fields: { sender: 'MAINSAIL', receiver: 'FOXTROT', body: 'ALFA BRAVO' },
      },
    };
    const rulesEngine: RulesMatcher = { tryMatch: () => Promise.resolve(match) };
    __setDeps({
      dataClient: client,
      rulesEngine,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-rule',
    });
    // A transcript the inline classifier would call OTHER — proving the
    // rule path wins and its captured fields reach the Message.
    const event = makeEvent({
      recordingId: 'rec-rule',
      transcript: 'unintelligible noise',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });
    await handler(event, {} as never, () => undefined);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: 'SKYKING',
        body: 'ALFA BRAVO',
        sender: 'MAINSAIL',
        receiver: 'FOXTROT',
        confidence: 0.9,
        flaggedForReview: false,
      }),
    );
  });

  it('applies an admin per-type confidence threshold from LinguisticConfig (#65)', async () => {
    // SKYKING threshold raised to 0.95 — above the rule match's 0.9 — so
    // the Message must land flagged even though it would be clean under
    // the default 0.8 gate.
    const { client, createSpy } = makeDataStub([], { SKYKING: 0.95 });
    const match: RuleMatch = {
      ruleId: 'skyking-v3',
      promptVersion: 3,
      confidence: 0.9,
      message: { messageType: 'SKYKING', fields: { body: 'ALFA' } },
    };
    __setDeps({
      dataClient: client,
      rulesEngine: { tryMatch: () => Promise.resolve(match) },
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-thr',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-thr',
        transcript: 'noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: 'SKYKING', confidence: 0.9, flaggedForReview: true }),
    );
  });

  it('falls back to the 0.8 default gate when the threshold config load throws (#65)', async () => {
    const { client, createSpy, configGetSpy } = makeDataStub();
    configGetSpy.mockRejectedValueOnce(new Error('ddb unavailable'));
    __setDeps({
      dataClient: client,
      rulesEngine: {
        tryMatch: () =>
          Promise.resolve({
            ruleId: 'r',
            promptVersion: 1,
            confidence: 0.9,
            message: { messageType: 'SKYKING', fields: {} },
          }),
      },
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-err',
    });
    await handler(
      makeEvent({ recordingId: 'rec-err', transcript: 'x', enqueuedAt: '2026-05-24T17:55:00Z' }),
      {} as never,
      () => undefined,
    );
    // 0.9 >= default 0.8 → clean, even though config load failed.
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ confidence: 0.9, flaggedForReview: false }),
    );
  });

  it('falls back to the default gate when the threshold value is malformed (#65)', async () => {
    // A non-JSON string value — JSON.parse fails, resolves to empty map.
    const { client, createSpy } = makeDataStub([], 'not-json');
    __setDeps({
      dataClient: client,
      rulesEngine: {
        tryMatch: () =>
          Promise.resolve({
            ruleId: 'r',
            promptVersion: 1,
            confidence: 0.9,
            message: { messageType: 'SKYKING', fields: {} },
          }),
      },
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-mal',
    });
    await handler(
      makeEvent({ recordingId: 'rec-mal', transcript: 'x', enqueuedAt: '2026-05-24T17:55:00Z' }),
      {} as never,
      () => undefined,
    );
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ confidence: 0.9, flaggedForReview: false }),
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

describe('linguistic — persists web-canonical key from the container (#514)', () => {
  it('writes webCanonicalKey + canonicalSizeBytes onto the Recording when present', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-wc-1',
    });
    await handler(
      makeEvent({
        kind: 'transcript',
        recordingId: 'rec-wc',
        transcript: 'skyking skyking',
        webCanonicalKey: 'recordings/web/rec-wc.opus',
        canonicalSizeBytes: 4096,
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-wc',
        webCanonicalKey: 'recordings/web/rec-wc.opus',
        canonicalSizeBytes: 4096,
        transcriptionStatus: 'PUBLISHED',
      }),
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

describe('linguistic — broadcast dedup (#454)', () => {
  it('links the Recording to an existing matching Message instead of creating a duplicate', async () => {
    // A prior SDR already published this SKYKING (same decoded body).
    const { client, createSpy, updateSpy, listSpy } = makeDataStub([
      { id: 'existing-msg', type: 'SKYKING', body: 'skyking skyking do not answer' },
    ]);
    __setDeps({ dataClient: client, now: () => new Date('2026-05-24T18:00:00Z') });
    await handler(
      makeEvent({
        recordingId: 'rec-2nd-sdr',
        transcript: 'skyking skyking do not answer',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(listSpy).toHaveBeenCalledOnce();
    // Dedup queries via the generic Message.list filter (no enum-keyed
    // GSI accessor exists — #524): same type, within the broadcast
    // window, excluding soft-deleted.
    expect(listSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        filter: {
          type: { eq: 'SKYKING' },
          broadcastTs: { between: [expect.any(String), expect.any(String)] },
          deletedAt: { attributeExists: false },
        },
      }),
    );
    // No new Message — the second capture links to the existing one.
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-2nd-sdr',
        messageId: 'existing-msg',
        transcriptionStatus: 'PUBLISHED',
      }),
    );
  });

  it('links when a concurrent create collides on the deterministic id (race guard)', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    // No candidate found, but the deterministic-id create collides — a
    // concurrent identical capture won the race.
    createSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    __setDeps({ dataClient: client, now: () => new Date('2026-05-24T18:00:00Z') });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handler(
      makeEvent({
        recordingId: 'rec-race',
        transcript: 'skyking skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // Recording links to the deterministic id (same as the winner's).
    const createdId = (createSpy.mock.calls[0]?.[0] as { id?: string } | undefined)?.id;
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-race',
        messageId: createdId,
        transcriptionStatus: 'PUBLISHED',
      }),
    );
    warnSpy.mockRestore();
  });
});

describe('linguistic — deleted-Recording tombstone (#459)', () => {
  it('drops a transcript message cleanly when the Recording was deleted in flight', async () => {
    const { client, updateSpy, deleteSpy } = makeDataStub();
    updateSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    __setDeps({
      dataClient: client,
      now: () => new Date('2026-05-24T18:00:00Z'),
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

    // Under dedup the Message may be shared by other recordings, so it
    // is NOT deleted — just drop the SQS message cleanly (#454/#459).
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).not.toHaveBeenCalled();
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

describe('linguistic — attempt log (#64)', () => {
  function parseAttempts(call: unknown): Array<Record<string, unknown>> {
    const input = call as { linguisticAttempts?: string };
    return JSON.parse(input.linguisticAttempts ?? '[]') as Array<Record<string, unknown>>;
  }

  it('appends a successful rules-path attempt onto the Recording', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      rulesEngine: {
        tryMatch: () =>
          Promise.resolve({
            ruleId: 'skyking-v3',
            promptVersion: 3,
            confidence: 0.9,
            message: { messageType: 'SKYKING', fields: {} },
          }),
      },
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({ recordingId: 'rec-a', transcript: 'noise', enqueuedAt: '2026-05-24T17:55:00Z' }),
      {} as never,
      () => undefined,
    );
    const attempts = parseAttempts(updateSpy.mock.calls[0]?.[0]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider: 'rules',
      promptVersion: 3,
      promptHash: null,
      success: true,
      ts: '2026-05-24T18:00:00.000Z',
    });
    expect(typeof attempts[0]?.resultHash).toBe('string');
  });

  it('records promptVersion null for the inline-fallback path', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({ dataClient: client, now: () => new Date('2026-05-24T18:00:00Z'), uuid: () => 'm' });
    await handler(
      makeEvent({
        recordingId: 'rec-b',
        transcript: 'Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const attempts = parseAttempts(updateSpy.mock.calls[0]?.[0]);
    expect(attempts[0]).toMatchObject({ provider: 'rules', promptVersion: null });
  });

  it('does not double-append on redrive when a matching success already exists', async () => {
    const { client, updateSpy, getSpy } = makeDataStub();
    // Recording already carries a successful (rules, null, null) attempt.
    getSpy.mockResolvedValueOnce({
      data: {
        id: 'rec-c',
        broadcastedAt: null,
        linguisticAttempts: [
          {
            provider: 'rules',
            promptVersion: null,
            promptHash: null,
            resultHash: 'prev',
            success: true,
            ts: '2026-05-24T17:00:00.000Z',
          },
        ],
      },
      errors: null,
    });
    __setDeps({ dataClient: client, now: () => new Date('2026-05-24T18:00:00Z'), uuid: () => 'm' });
    await handler(
      makeEvent({
        recordingId: 'rec-c',
        transcript: 'Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const attempts = parseAttempts(updateSpy.mock.calls[0]?.[0]);
    // shouldSkip → no new entry; the prior one is persisted unchanged.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.resultHash).toBe('prev');
  });
});

describe('linguistic — Bedrock AI fallback (#63)', () => {
  const fbSuccess = {
    message: { type: 'SKYKING', confidence: 0.92, sender: 'MAINSAIL', body: 'ALFA BRAVO' },
    modelId: 'anthropic.claude-test',
    promptVersion: 1,
    retried: false,
    rules: [] as ProposedRule[],
  };
  // rules engine that never matches → inline classifier runs.
  const noRules: RulesMatcher = { tryMatch: () => Promise.resolve(null) };

  function attemptsOf(call: unknown): Array<Record<string, unknown>> {
    const input = call as { linguisticAttempts?: string };
    return JSON.parse(input.linguisticAttempts ?? '[]') as Array<Record<string, unknown>>;
  }

  it('invokes Bedrock when rules + inline classifier both miss; uses its parse', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-bed',
        transcript: 'unintelligible zzzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).toHaveBeenCalledOnce();
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: 'SKYKING', confidence: 0.92, sender: 'MAINSAIL' }),
    );
    const attempts = attemptsOf(updateSpy.mock.calls[0]?.[0]);
    expect(attempts[0]).toMatchObject({ provider: 'bedrock', promptVersion: 1, success: true });
    expect(typeof attempts[0]?.promptHash).toBe('string');
  });

  it('logs a FAILED bedrock attempt and keeps OTHER when Bedrock returns null', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(null);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-bedfail',
        transcript: 'unintelligible zzzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).toHaveBeenCalledOnce();
    expect(createSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ type: 'OTHER' }));
    const attempts = attemptsOf(updateSpy.mock.calls[0]?.[0]);
    expect(attempts[0]).toMatchObject({ provider: 'bedrock', success: false, resultHash: null });
  });

  it('routes a recognized-but-sub-threshold parse to Bedrock when the gate is raised', async () => {
    // Gate raised to 0.9 → an inline SKYKING (0.85) now falls below it and
    // goes to the AI — the 0-rule launch posture (everything → AI).
    const { client } = makeDataStub([], null, 0.9);
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-gate',
        transcript: 'Skyking, Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).toHaveBeenCalledOnce();
  });

  it('falls back to the default gate when the configured threshold is out of range', async () => {
    // Out-of-range (5) → loader returns the 0.5 default → SKYKING (0.85)
    // stays on the cheap path, no Bedrock.
    const { client } = makeDataStub([], null, 5);
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-oor',
        transcript: 'Skyking, Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).not.toHaveBeenCalled();
  });

  it('routes an empty/near-silent transcript through the fallback gate without crashing', async () => {
    const { client, createSpy } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(null); // model declines empty input
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({ recordingId: 'rec-empty', transcript: '', enqueuedAt: '2026-05-24T17:55:00Z' }),
      {} as never,
      () => undefined,
    );
    // 0.1 < 0.5 → bedrock branch; null → OTHER Message still created.
    expect(createSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ type: 'OTHER' }));
  });

  it('routes a LOW-confidence rule match to Bedrock (#543)', async () => {
    // A rule matched but its own confidence (0.4) is below the default
    // 0.5 gate → the parse goes to the AI rather than being trusted.
    const lowConfRule: RulesMatcher = {
      tryMatch: () =>
        Promise.resolve({
          ruleId: 'shaky-rule',
          promptVersion: 1,
          confidence: 0.4,
          message: { messageType: 'SKYKING', fields: {} },
        }),
    };
    const { client } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: lowConfRule,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-lowc',
        transcript: 'skyking',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).toHaveBeenCalledOnce();
  });

  it('persists AI-proposed rules with hybrid activation (#544)', async () => {
    const { client, ruleCreateSpy } = makeDataStub();
    const rules: ProposedRule[] = [
      { component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING', confidence: 0.95 },
      {
        component: 'SENDER',
        appliesToType: 'SKYKING',
        pattern: 'THIS IS (?<sender>\\w+)',
        captureMap: { sender: 'sender' },
        confidence: 0.6,
      },
    ];
    const bedrockFallback = vi.fn().mockResolvedValue({ ...fbSuccess, rules });
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-rules',
        transcript: 'zzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(ruleCreateSpy).toHaveBeenCalledTimes(2);
    // High-confidence (0.95) auto-activates; low-confidence (0.6) queues.
    const calls = ruleCreateSpy.mock.calls.map(
      (c) =>
        c[0] as {
          component: string;
          enabled: boolean;
          captureMap: string;
          messageType: string;
          notes: string;
          appliesToType?: string;
        },
    );
    const typeRule = calls.find((c) => c.component === 'TYPE');
    expect(typeRule).toMatchObject({
      enabled: true,
      messageType: 'SKYKING',
      notes: 'AI-generated (#544)',
    });
    expect(calls.find((c) => c.component === 'SENDER')).toMatchObject({
      enabled: false,
      appliesToType: 'SKYKING',
    });
    // captureMap stringified for the AWSJSON column.
    expect(typeof typeRule?.captureMap).toBe('string');
  });

  it('writes the remaining rules when one create fails (#544)', async () => {
    const { client, ruleCreateSpy } = makeDataStub();
    ruleCreateSpy
      .mockResolvedValueOnce({ data: null, errors: [{ message: 'boom' }] })
      .mockResolvedValueOnce({ data: { id: 'ok' }, errors: null });
    const rules: ProposedRule[] = [
      { component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING', confidence: 0.95 },
      { component: 'BODY', appliesToType: 'SKYKING', pattern: '(?<body>.+)', confidence: 0.9 },
    ];
    const bedrockFallback = vi.fn().mockResolvedValue({ ...fbSuccess, rules });
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-rfail',
        transcript: 'zzz',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // First errored (logged, not thrown); second still attempted.
    expect(ruleCreateSpy).toHaveBeenCalledTimes(2);
  });

  it('does not re-write rules on a redrive (prior bedrock attempt logged) (#544)', async () => {
    const { client, getSpy, ruleCreateSpy } = makeDataStub();
    getSpy.mockResolvedValueOnce({
      data: {
        id: 'rec-redr',
        broadcastedAt: null,
        linguisticAttempts: [
          {
            provider: 'bedrock',
            promptVersion: 1,
            promptHash: 'h',
            resultHash: null,
            success: false,
            ts: '2026-05-24T17:00:00.000Z',
          },
        ],
      },
      errors: null,
    });
    const rules: ProposedRule[] = [
      { component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING', confidence: 0.95 },
    ];
    const bedrockFallback = vi.fn().mockResolvedValue({ ...fbSuccess, rules });
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-redr',
        transcript: 'zzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(ruleCreateSpy).not.toHaveBeenCalled();
  });

  it('feeds the failed attempt + ruleset snapshot into the Bedrock context (#544b)', async () => {
    const engineWithRules: RulesMatcher = {
      tryMatch: () => Promise.resolve(null),
      snapshot: () =>
        Promise.resolve([
          {
            id: 'r1',
            component: 'TYPE' as const,
            messageType: 'SKYKING',
            appliesToType: null,
            pattern: 'SKYKING',
            confidence: 0.9,
          },
        ]),
    };
    const { client } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: engineWithRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-ctx',
        transcript: 'zzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const ctx = (bedrockFallback.mock.calls[0]?.[1] as { context?: string })?.context ?? '';
    expect(ctx).toContain('best attempt');
    expect(ctx).toContain('SKYKING'); // the active rule is listed for refinement
  });

  it('does NOT invoke Bedrock when the inline classifier recognizes the type', async () => {
    const { client } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-known',
        transcript: 'Skyking, Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).not.toHaveBeenCalled();
  });

  it('feeds the active DB prompt template (admin-edited) into the Bedrock call', async () => {
    const { client, promptListSpy } = makeDataStub();
    promptListSpy.mockResolvedValueOnce({
      data: [{ body: 'CUSTOM ADMIN PROMPT {{TRANSCRIPT}}', version: 7 }],
      errors: null,
    });
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-tmpl',
        transcript: 'unintelligible zzzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).toHaveBeenCalledWith(
      'unintelligible zzzz noise',
      expect.objectContaining({
        promptTemplate: 'CUSTOM ADMIN PROMPT {{TRANSCRIPT}}',
        promptVersion: 7,
      }),
    );
    // Scoped to the Bedrock parse promptId (active is per-promptId).
    expect(promptListSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        filter: { promptId: { eq: 'linguistic-parse-bedrock' }, isActive: { eq: true } },
      }),
    );
  });

  it('re-invokes Bedrock on redrive but does not double-append the attempt log', async () => {
    // A prior bedrock success is already logged for this (prompt) key.
    // The call is NOT skipped (the log lacks the parsed type, so a skip
    // would mis-dedup) — but `appendAttempt` must not duplicate the entry.
    const transcript = 'unintelligible zzzz noise';
    const { rendered, promptVersion } = renderFallbackPrompt(transcript);
    const promptHash = hashPrompt(rendered);
    const { client, getSpy, updateSpy } = makeDataStub();
    getSpy.mockResolvedValueOnce({
      data: {
        id: 'rec-redrive',
        broadcastedAt: null,
        linguisticAttempts: [
          {
            provider: 'bedrock',
            promptVersion,
            promptHash,
            resultHash: 'prev',
            success: true,
            ts: '2026-05-24T17:00:00.000Z',
          },
        ],
      },
      errors: null,
    });
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({ recordingId: 'rec-redrive', transcript, enqueuedAt: '2026-05-24T17:55:00Z' }),
      {} as never,
      () => undefined,
    );
    // Re-invoked (correctness over the micro-cost-skip)...
    expect(bedrockFallback).toHaveBeenCalledOnce();
    // ...but the append is de-duplicated — log stays length 1.
    const attempts = attemptsOf(updateSpy.mock.calls[0]?.[0]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.resultHash).toBe('prev');
  });
});
