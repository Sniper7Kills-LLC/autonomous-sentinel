import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

import {
  handler,
  classify,
  parseMessage,
  filterNewProposedRules,
  ruleDedupKey,
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
  /** Message.get — reads M_old on a re-run (#556). */
  msgGetSpy: ReturnType<typeof vi.fn>;
  /** Message.update — soft-deletes superseded M_old (#556). */
  msgUpdateSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
  listSpy: ReturnType<typeof vi.fn>;
  /** Recording.listRecordingByMessageId — counts M_old siblings (#556). */
  recByMsgSpy: ReturnType<typeof vi.fn>;
  configGetSpy: ReturnType<typeof vi.fn>;
  promptListSpy: ReturnType<typeof vi.fn>;
  ruleCreateSpy: ReturnType<typeof vi.fn>;
  traceCreateSpy: ReturnType<typeof vi.fn>;
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
): DataStub {
  const createSpy = vi.fn().mockResolvedValue({ data: { id: 'msg-uuid-1' }, errors: null });
  const updateSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  const deleteSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  // Message.get → M_old lookup on a re-run (#556). Default: no prior
  // message exists (first run), so the supersede path is never entered.
  const msgGetSpy = vi.fn().mockResolvedValue({ data: null, errors: null });
  // Message.update → soft-delete of a superseded M_old (#556).
  const msgUpdateSpy = vi.fn().mockResolvedValue({ data: {}, errors: null });
  // Recording.get → no broadcastedAt (testing-portal upload), no prior
  // messageId (first run) by default.
  const getSpy = vi
    .fn()
    .mockResolvedValue({ data: { id: 'rec', broadcastedAt: null, messageId: null }, errors: null });
  const listSpy = vi.fn().mockResolvedValue({ data: candidates, errors: null });
  // Recording.listRecordingByMessageId → M_old sibling count (#556).
  const recByMsgSpy = vi.fn().mockResolvedValue({ data: [], errors: null });
  const configGetSpy = vi.fn().mockImplementation(() => {
    return Promise.resolve({
      data: confidenceValue === null ? null : { value: confidenceValue },
      errors: null,
    });
  });
  // No active prompt template by default → ai-fallback uses the bundled
  // markdown default (#self-improving-loop).
  const promptListSpy = vi.fn().mockResolvedValue({ data: [], errors: null });
  const ruleCreateSpy = vi.fn().mockResolvedValue({ data: { id: 'rule-1' }, errors: null });
  const traceCreateSpy = vi.fn().mockResolvedValue({ data: { id: 'trace-1' }, errors: null });
  const client: LinguisticDataClient = {
    models: {
      Message: {
        create: createSpy as never,
        delete: deleteSpy as never,
        list: listSpy as never,
        get: msgGetSpy as never,
        update: msgUpdateSpy as never,
      },
      Recording: {
        get: getSpy as never,
        update: updateSpy as never,
        listRecordingByMessageId: recByMsgSpy as never,
      },
      LinguisticConfig: { get: configGetSpy as never },
      LinguisticPromptTemplate: {
        list: promptListSpy as never,
      },
      LinguisticRule: { create: ruleCreateSpy as never },
      LinguisticTrace: { create: traceCreateSpy as never },
    },
  };
  return {
    client,
    createSpy,
    updateSpy,
    deleteSpy,
    msgGetSpy,
    msgUpdateSpy,
    getSpy,
    listSpy,
    recByMsgSpy,
    configGetSpy,
    promptListSpy,
    ruleCreateSpy,
    traceCreateSpy,
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

/**
 * Bedrock fallback stub returning a successful parse. The hard-coded
 * classifier yields TYPE only, so most transcripts now route to Bedrock
 * (#552); tests inject this to stay deterministic + offline.
 */
function bedrockOk(message: {
  type: string;
  confidence?: number;
  sender?: string;
  receiver?: string;
  body?: string;
}) {
  return vi.fn().mockResolvedValue({
    message: { confidence: 0.9, ...message },
    rules: [],
    modelId: 'us.anthropic.claude-opus-4-8',
    promptVersion: 1,
    retried: false,
    diagnostics: {
      renderedPrompt: 'RENDERED PROMPT FIXTURE',
      rawResponse: { output: { message: { content: [] } } },
    },
  });
}

/** Bedrock fallback stub that fails to parse (returns null). */
const bedrockNull = (): Promise<null> => Promise.resolve(null);

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

  it('round-trips a finite transcriptionConfidence in [0,1] (#581)', () => {
    const out = parseMessage(
      JSON.stringify({
        kind: 'transcript',
        recordingId: 'r-1',
        transcript: 'skyking',
        transcriptionConfidence: 0.73,
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
    );
    if (out.kind === 'transcript') {
      expect(out.transcriptionConfidence).toBe(0.73);
    }
  });

  it('drops an out-of-range / non-finite transcriptionConfidence (#581)', () => {
    for (const bad of [1.5, -0.1, Number.NaN, 'x']) {
      const out = parseMessage(
        JSON.stringify({
          kind: 'transcript',
          recordingId: 'r-1',
          transcript: 'skyking',
          transcriptionConfidence: bad,
          enqueuedAt: '2026-05-24T18:00:00Z',
        }),
      );
      if (out.kind === 'transcript') {
        expect(out.transcriptionConfidence).toBeUndefined();
      }
    }
  });
});

describe('linguistic — handler happy path', () => {
  it('creates Message via Amplify Data + advances Recording to PUBLISHED', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    // Type-only inline classify carries no fields → routes to Bedrock,
    // which supplies the parse (#552).
    const bedrockFallback = bedrockOk({ type: 'SKYKING', body: 'Skyking, Skyking, do not answer' });
    __setDeps({
      dataClient: client,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-1',
    });
    const event = makeEvent({
      recordingId: 'rec-1',
      transcript: 'Skyking, Skyking, do not answer',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });
    await handler(event, {} as never, () => undefined);

    expect(bedrockFallback).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledOnce();
    // id is now a deterministic content hash (#454 dedup race guard),
    // not the injected uuid — assert the rest of the payload.
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: 'SKYKING',
        broadcastTs: '2026-05-24T17:55:00Z',
        body: 'Skyking, Skyking, do not answer',
        confidence: 0.9,
        flaggedForReview: false,
        publishedAt: '2026-05-24T18:00:00.000Z',
      }),
    );

    // TRANSCRIBING → PARSING on pickup (calls[0]), then the terminal
    // PUBLISHED write (calls[1]) — #433 status ladder.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 'rec-1', transcriptionStatus: 'PARSING' }),
    );
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-1',
        messageId: 'msg-uuid-1',
        transcript: 'Skyking, Skyking, do not answer',
        transcriptionStatus: 'PUBLISHED',
      }),
    );
  });

  it('writes a LinguisticTrace row after publish capturing rules + bedrock detail (#744)', async () => {
    const { client, traceCreateSpy } = makeDataStub();
    const bedrockFallback = bedrockOk({ type: 'SKYKING', body: 'Skyking do not answer' });
    __setDeps({
      dataClient: client,
      bedrockFallback,
      // Deterministic rule evaluations for the trace (real engine would hit DDB).
      rulesEngine: {
        tryMatch: () => Promise.resolve(null),
        tryMatchTraced: () =>
          Promise.resolve({
            match: null,
            evaluations: [
              {
                ruleId: 'r1',
                component: 'TYPE',
                messageType: 'SKYKING',
                appliesToType: null,
                pattern: 'SKYKING',
                confidence: 0.9,
                matched: false,
                matchedText: null,
                captures: {},
              },
            ],
          }),
      },
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-1',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-1',
        transcript: 'Skyking do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );

    expect(traceCreateSpy).toHaveBeenCalledOnce();
    const row = traceCreateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.recordingId).toBe('rec-1');
    expect(row.bedrockInvoked).toBe(true);
    expect(row.bedrockRenderedPrompt).toBe('RENDERED PROMPT FIXTURE');
    expect(JSON.parse(row.rulesEvaluated as string)).toHaveLength(1);
    expect(JSON.parse(row.finalResult as string)).toMatchObject({
      type: 'SKYKING',
      source: 'bedrock',
    });
    expect(typeof row.ttl).toBe('number');
  });

  it('publishes even when the trace write fails (best-effort, non-fatal) (#744)', async () => {
    const { client, updateSpy, traceCreateSpy } = makeDataStub();
    traceCreateSpy.mockRejectedValue(new Error('trace table unavailable'));
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'x' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-1',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-1',
        transcript: 'Skyking do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // The authoritative PUBLISHED write still happened despite the trace failure.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ id: 'rec-1', transcriptionStatus: 'PUBLISHED' }),
    );
  });

  it('skips entirely (no re-parse, no status write) when the recording is already terminal (#741)', async () => {
    const { client, createSpy, updateSpy, getSpy } = makeDataStub();
    getSpy.mockResolvedValue({
      data: { id: 'rec', transcriptionStatus: 'PUBLISHED' },
      errors: null,
    });
    const bedrockFallback = bedrockOk({ type: 'SKYKING', body: 'x' });
    __setDeps({
      dataClient: client,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-1',
    });
    const event = makeEvent({
      recordingId: 'rec-dup',
      transcript: 'Skyking, Skyking, do not answer',
      enqueuedAt: '2026-05-24T17:55:00Z',
    });
    await handler(event, {} as never, () => undefined);

    // No re-parse, no Message, no status write — the terminal recording is left untouched.
    expect(bedrockFallback).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('recomputes the uploader reputation after publishing (#480)', async () => {
    const { client, updateSpy } = makeDataStub();
    // Recording.update returns the full row incl. uploaderId on publish.
    updateSpy.mockResolvedValue({
      data: { id: 'rec-1', uploaderId: 'uploader-7', transcriptionStatus: 'PUBLISHED' },
      errors: null,
    });
    const repSpy = vi.fn().mockResolvedValue(1.3);
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'Skyking, Skyking, do not answer' }),
      repRecompute: repSpy,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-1',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-1',
        transcript: 'Skyking, Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(repSpy).toHaveBeenCalledWith(expect.anything(), 'uploader-7');
  });

  it('publishes even when the reputation recompute throws (best-effort, #480)', async () => {
    const { client, updateSpy } = makeDataStub();
    updateSpy.mockResolvedValue({
      data: { id: 'rec-1', uploaderId: 'uploader-7', transcriptionStatus: 'PUBLISHED' },
      errors: null,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'Skyking, Skyking, do not answer' }),
      repRecompute: vi.fn().mockRejectedValue(new Error('rep down')),
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-uuid-1',
    });
    // Must resolve (not throw) — recompute is best-effort.
    await expect(
      handler(
        makeEvent({
          recordingId: 'rec-1',
          transcript: 'Skyking, Skyking, do not answer',
          enqueuedAt: '2026-05-24T17:55:00Z',
        }),
        {} as never,
        () => undefined,
      ),
    ).resolves.toBeUndefined();
    expect(updateSpy).toHaveBeenCalled();
  });

  it('routes a high-confidence type-only inline match to Bedrock for fields (#552)', async () => {
    // RADIOCHECK scores 0.85 from the inline classifier but carries NO
    // fields — it must still route to Bedrock (type-confidence is not a
    // proxy for a complete parse). Bedrock supplies the sender.
    const { client, createSpy } = makeDataStub();
    const bedrockFallback = bedrockOk({
      type: 'RADIOCHECK',
      sender: 'MAINSAIL',
      body: 'test count 1 2 3 4 5',
    });
    __setDeps({
      dataClient: client,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-rc-1',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-rc',
        transcript: 'This is Mainsail with a test count of 1 2 3 4 5',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).toHaveBeenCalledOnce();
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: 'RADIOCHECK', sender: 'MAINSAIL' }),
    );
  });

  it('lets Bedrock re-verify/override the inline type (#552)', async () => {
    // Inline classify would call this RADIOCHECK ("test count"); Bedrock
    // corrects it to SKYKING. The Bedrock type wins.
    const { client, createSpy } = makeDataStub();
    const bedrockFallback = bedrockOk({ type: 'SKYKING', body: 'CODEWORD time 14 auth 9d' });
    __setDeps({
      dataClient: client,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-ov-1',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-ov',
        transcript: 'garbled test count but actually a skyking',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(createSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ type: 'SKYKING' }));
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
            message: { messageType: 'SKYKING', fields: { body: 'ALFA' } },
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
            message: { messageType: 'SKYKING', fields: { body: 'ALFA' } },
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
    // OTHER carries no fields → routes to Bedrock; Bedrock can't parse it
    // either (null) → the low-confidence inline result stands and flags.
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
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
  it('decodes the Bedrock-captured body + carries its sender/receiver for ALLSTATIONS', async () => {
    const { client, createSpy, updateSpy } = makeDataStub();
    // Fields come from Bedrock (#552), not transcript extraction. The
    // captured phonetic body is still decoded to alphanumeric.
    const bedrockFallback = bedrockOk({
      type: 'ALLSTATIONS',
      sender: 'mainsail',
      receiver: 'ICEMAN',
      body: 'alpha charlie delta',
    });
    __setDeps({
      dataClient: client,
      bedrockFallback,
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
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ id: 'rec-as', transcript }),
    );
  });

  it('falls back to the raw transcript when an ALLSTATIONS body has no decodable letters', async () => {
    const { client, createSpy } = makeDataStub();
    // Bedrock can't parse → inline ALLSTATIONS type stands, no fields.
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
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
      bedrockFallback: bedrockNull,
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
      // Successful parse → PUBLISHED (this test is about key persistence,
      // not the AI-fail path which now lands PARSE_FAILED, #579).
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'skyking skyking' }),
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
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-wc',
        webCanonicalKey: 'recordings/web/rec-wc.opus',
        canonicalSizeBytes: 4096,
        transcriptionStatus: 'PUBLISHED',
      }),
    );
  });
});

describe('linguistic — persists transcription confidence from the container (#581)', () => {
  it('writes transcriptionConfidence onto the Recording when present', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'skyking skyking' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-tc-1',
    });
    await handler(
      makeEvent({
        kind: 'transcript',
        recordingId: 'rec-tc',
        transcript: 'skyking skyking',
        transcriptionConfidence: 0.82,
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-tc',
        transcriptionConfidence: 0.82,
        transcriptionStatus: 'PUBLISHED',
      }),
    );
  });

  it('omits transcriptionConfidence when the message lacks it', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'skyking skyking' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'msg-tc-2',
    });
    await handler(
      makeEvent({
        kind: 'transcript',
        recordingId: 'rec-tc-2',
        transcript: 'skyking skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(updateSpy.mock.calls[1]?.[0]).not.toHaveProperty('transcriptionConfidence');
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
      bedrockFallback: bedrockNull,
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
    // updateSpy is called twice — the PARSING mark then the PARSE_FAILED mark.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
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
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
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
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
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
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
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
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        id: 'rec-race',
        messageId: createdId,
        transcriptionStatus: 'PUBLISHED',
      }),
    );
    warnSpy.mockRestore();
  });
});

describe('linguistic — recover soft-deleted Message on re-link (#599)', () => {
  it('recovers a soft-deleted Message when a re-run collides on its deterministic id', async () => {
    const { client, createSpy, updateSpy, msgGetSpy, msgUpdateSpy } = makeDataStub();
    // Dedup list excludes soft-deleted → no candidate. The deterministic-id
    // create then collides with the EXISTING (soft-deleted) Message.
    createSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    // Message.get (recovery read) → the colliding Message is soft-deleted
    // by a prior supersede (#556), so it is eligible for recovery.
    msgGetSpy.mockResolvedValue({
      data: {
        id: 'm-old',
        deletedAt: '2026-05-20T00:00:00Z',
        deletedReason: 'Superseded by re-run of Recording rec-recover (#556)',
      },
      errors: null,
    });
    const auditSpy = vi.fn().mockResolvedValue('audit-1');
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
      audit: auditSpy,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec-recover',
        transcript: 'skyking skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const createdId = (createSpy.mock.calls[0]?.[0] as { id?: string } | undefined)?.id;
    // Message recovered: deletedAt/deletedBy/deletedReason cleared + republished.
    expect(msgUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: createdId,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
        publishedAt: '2026-05-24T18:00:00.000Z',
      }),
    );
    // MESSAGE_RESTORE audit written for the recovery.
    expect(auditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MESSAGE_RESTORE', targetId: createdId }),
    );
    // Recording still links to the recovered Message.
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ id: 'rec-recover', messageId: createdId }),
    );
  });

  it('does NOT recover an admin-deleted Message (only supersede deletes recover)', async () => {
    const { client, createSpy, msgGetSpy, msgUpdateSpy } = makeDataStub();
    createSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    // Colliding Message was deleted by an admin (reason is NOT a supersede).
    msgGetSpy.mockResolvedValue({
      data: { id: 'm-admin', deletedAt: '2026-05-20T00:00:00Z', deletedReason: 'Spam' },
      errors: null,
    });
    const auditSpy = vi.fn().mockResolvedValue('audit-1');
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
      audit: auditSpy,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec-admin',
        transcript: 'skyking skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // Admin delete respected: no recovery update, no MESSAGE_RESTORE audit.
    expect(msgUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MESSAGE_RESTORE' }),
    );
  });

  it('does NOT recover when the colliding Message is already live', async () => {
    const { client, createSpy, msgGetSpy, msgUpdateSpy } = makeDataStub();
    createSpy.mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    // Colliding Message is NOT soft-deleted.
    msgGetSpy.mockResolvedValue({ data: { id: 'm-live', deletedAt: null }, errors: null });
    const auditSpy = vi.fn().mockResolvedValue('audit-1');
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
      audit: auditSpy,
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec-live',
        transcript: 'skyking skyking',
        enqueuedAt: '2026-05-24T18:00:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // No recovery update, no MESSAGE_RESTORE audit.
    expect(msgUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MESSAGE_RESTORE' }),
    );
  });
});

describe('linguistic — deleted-Recording tombstone (#459)', () => {
  it('drops a transcript message cleanly when the Recording was deleted in flight', async () => {
    const { client, updateSpy, deleteSpy } = makeDataStub();
    updateSpy
      // first call: the best-effort PARSING mark succeeds
      .mockResolvedValueOnce({ data: {}, errors: null })
      // second call: the terminal PUBLISHED write hits the tombstone
      .mockResolvedValueOnce({ data: null, errors: CONDITIONAL_CHECK_ERRORS });
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
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
    // Two updates: the PARSING mark then the tombstoned terminal write.
    expect(updateSpy).toHaveBeenCalledTimes(2);
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
      // first call: the best-effort PARSING mark succeeds
      .mockResolvedValueOnce({ data: {}, errors: null })
      // second call: the PUBLISHED write fails with a real error
      .mockResolvedValueOnce({ data: null, errors: [{ message: 'throughput exceeded' }] })
      // third call: the PARSE_FAILED mark
      .mockResolvedValueOnce({ data: {}, errors: null });
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockNull,
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
            message: { messageType: 'SKYKING', fields: { body: 'ALFA' } },
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
    const attempts = parseAttempts(updateSpy.mock.calls[1]?.[0]);
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

  it('does not double-append on redrive when a matching success already exists', async () => {
    const { client, updateSpy, getSpy } = makeDataStub();
    // A field-bearing rule match keeps this on the rules path (no AI).
    const ruleMatch: RuleMatch = {
      ruleId: 'skyking-v3',
      promptVersion: 3,
      confidence: 0.9,
      message: { messageType: 'SKYKING', fields: { body: 'ALFA' } },
    };
    // Recording already carries a successful (rules, 3, null) attempt.
    getSpy.mockResolvedValueOnce({
      data: {
        id: 'rec-c',
        broadcastedAt: null,
        linguisticAttempts: [
          {
            provider: 'rules',
            promptVersion: 3,
            promptHash: null,
            resultHash: 'prev',
            success: true,
            ts: '2026-05-24T17:00:00.000Z',
          },
        ],
      },
      errors: null,
    });
    __setDeps({
      dataClient: client,
      rulesEngine: { tryMatch: () => Promise.resolve(ruleMatch) },
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-c',
        transcript: 'Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const attempts = parseAttempts(updateSpy.mock.calls[1]?.[0]);
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
    const attempts = attemptsOf(updateSpy.mock.calls[1]?.[0]);
    expect(attempts[0]).toMatchObject({ provider: 'bedrock', promptVersion: 1, success: true });
    expect(typeof attempts[0]?.promptHash).toBe('string');
  });

  it('logs the raw Bedrock parse + proposed rules for debugging (#560)', async () => {
    const { client } = makeDataStub();
    const rules: ProposedRule[] = [
      { component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING', confidence: 0.95 },
    ];
    const bedrockFallback = vi.fn().mockResolvedValue({ ...fbSuccess, rules });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-log',
        transcript: 'zzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const parseLog = infoSpy.mock.calls.find((c) => c[0] === 'linguistic: bedrock parse');
    expect(parseLog).toBeDefined();
    expect(parseLog?.[1]).toMatchObject({
      recordingId: 'rec-log',
      parsed: { type: 'SKYKING', sender: 'MAINSAIL' },
      rules: [expect.objectContaining({ component: 'TYPE', pattern: 'SKYKING' })],
    });
    infoSpy.mockRestore();
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
    const attempts = attemptsOf(updateSpy.mock.calls[1]?.[0]);
    expect(attempts[0]).toMatchObject({ provider: 'bedrock', success: false, resultHash: null });
    // #579: an AI-fail fresh publish is force-flagged, and the Recording
    // lands PARSE_FAILED (linked flagged Message, surfaced for review).
    expect(createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ flaggedForReview: true }),
    );
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ transcriptionStatus: 'PARSE_FAILED', transcriptionFailed: true }),
    );
  });

  it('routes a type-only inline match to Bedrock regardless of type-confidence (#552)', async () => {
    // An inline SKYKING (0.85) carries no fields → it always goes to the
    // AI for field extraction — the 0-rule launch posture (everything → AI).
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
        recordingId: 'rec-gate',
        transcript: 'Skyking, Skyking, do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(bedrockFallback).toHaveBeenCalledOnce();
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
    // No captured fields → bedrock branch; null → OTHER Message still created.
    expect(createSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ type: 'OTHER' }));
  });

  it('routes a rule match that captured no fields to Bedrock (#552)', async () => {
    // A rule matched the TYPE but captured no fields → the parse goes to
    // the AI for field extraction rather than publishing type-only.
    const noFieldRule: RulesMatcher = {
      tryMatch: () =>
        Promise.resolve({
          ruleId: 'type-only-rule',
          promptVersion: 1,
          confidence: 0.9,
          message: { messageType: 'SKYKING', fields: {} },
        }),
    };
    const { client } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: noFieldRule,
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

  it('skips persisting AI-proposed rules that duplicate an active rule (#575)', async () => {
    // The active ruleset already contains the TYPE rule the model
    // re-proposes; only the genuinely-new SENDER rule should be written.
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
            confidence: 0.95,
          },
        ]),
    };
    const { client, ruleCreateSpy } = makeDataStub();
    const rules: ProposedRule[] = [
      // duplicate of the active rule (trailing whitespace must not defeat dedup)
      { component: 'TYPE', messageType: 'SKYKING', pattern: 'SKYKING  ', confidence: 0.95 },
      {
        component: 'SENDER',
        appliesToType: 'SKYKING',
        pattern: 'THIS IS (?<sender>\\w+)',
        confidence: 0.6,
      },
    ];
    const bedrockFallback = vi.fn().mockResolvedValue({ ...fbSuccess, rules });
    __setDeps({
      dataClient: client,
      rulesEngine: engineWithRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec-dedup',
        transcript: 'zzz noise',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(ruleCreateSpy).toHaveBeenCalledTimes(1);
    expect((ruleCreateSpy.mock.calls[0]![0] as { component: string }).component).toBe('SENDER');
  });

  it('does NOT invoke Bedrock when a rule captured the fields', async () => {
    // The inverse of #552: a field-bearing rule match is trusted and the
    // AI is skipped.
    const { client } = makeDataStub();
    const bedrockFallback = vi.fn().mockResolvedValue(fbSuccess);
    __setDeps({
      dataClient: client,
      rulesEngine: {
        tryMatch: () =>
          Promise.resolve({
            ruleId: 'skyking-v3',
            promptVersion: 3,
            confidence: 0.9,
            message: { messageType: 'SKYKING', fields: { body: 'ALFA BRAVO' } },
          }),
      },
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
    const attempts = attemptsOf(updateSpy.mock.calls[1]?.[0]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.resultHash).toBe('prev');
  });
});

describe('linguistic — multi-transcript collection + reconcile (#593)', () => {
  const noRules: RulesMatcher = { tryMatch: () => Promise.resolve(null) };

  function transcriptsOf(call: unknown): Array<Record<string, unknown>> {
    const input = call as { transcripts?: string };
    return JSON.parse(input.transcripts ?? '[]') as Array<Record<string, unknown>>;
  }

  it('writes a single-entry transcripts collection on the default whisper path', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback: bedrockOk({ type: 'OTHER', confidence: 0.6 }),
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'SOLO TRANSCRIPT',
        transcriptionConfidence: 0.71,
        wordTimestampsKey: 'wts/whisper/rec.json',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const update = updateSpy.mock.calls[1]?.[0] as {
      transcript?: string;
      wordTimestampsKey?: string;
    };
    expect(update.transcript).toBe('SOLO TRANSCRIPT');
    // Default single-whisper path still surfaces the top-level
    // wordTimestampsKey — sourced from the entry's own key (set from
    // msg.wordTimestampsKey at UPSERT time), not a msg fallback.
    expect(update.wordTimestampsKey).toBe('wts/whisper/rec.json');
    const transcripts = transcriptsOf(update);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({
      backend: 'whisper-local',
      transcript: 'SOLO TRANSCRIPT',
      transcriptionConfidence: 0.71,
      wordTimestampsKey: 'wts/whisper/rec.json',
    });
  });

  it('UPSERTS a second backend into the existing transcripts without dropping the first', async () => {
    const { client, getSpy, updateSpy } = makeDataStub();
    // Recording already carries a whisper-local transcript (#593).
    getSpy.mockResolvedValue({
      data: {
        id: 'rec',
        broadcastedAt: null,
        messageId: null,
        transcripts: [
          {
            backend: 'whisper-local',
            transcript: 'OXTRA HOTEL',
            transcriptionConfidence: 0.7,
            wordTimestampsKey: 'wts/whisper/rec.json',
            ts: '2026-05-24T17:00:00Z',
          },
        ],
      },
      errors: null,
    });
    const bedrockFallback = bedrockOk({ type: 'SKYKING', confidence: 0.95, body: 'FOXTROT HOTEL' });
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback,
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    // amazon-transcribe arrives with a higher-confidence reading + its own
    // (backend-specific) word-timestamps key.
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'FOXTROT HOTEL',
        backend: 'amazon-transcribe',
        transcriptionConfidence: 0.9,
        wordTimestampsKey: 'wts/amazon/rec.json',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    const update = updateSpy.mock.calls[1]?.[0] as {
      transcript?: string;
      transcriptionConfidence?: number;
      wordTimestampsKey?: string;
    };
    const transcripts = transcriptsOf(update);
    expect(transcripts).toHaveLength(2);
    expect(transcripts.map((t) => t.backend)).toEqual(
      expect.arrayContaining(['whisper-local', 'amazon-transcribe']),
    );
    // Primary = highest confidence → amazon-transcribe mirrors the top-level.
    expect(update.transcript).toBe('FOXTROT HOTEL');
    expect(update.transcriptionConfidence).toBe(0.9);
    // Word timestamps are backend-specific: the top-level key MUST be the
    // PRIMARY (amazon-transcribe) entry's key, NOT the whisper key — pairing
    // the amazon transcript with whisper offsets would break scrub-to-text.
    expect(update.wordTimestampsKey).toBe('wts/amazon/rec.json');
    // Bedrock got BOTH transcripts to reconcile across.
    const fbOpts = bedrockFallback.mock.calls[0]?.[1] as {
      transcripts?: Array<{ backend: string }>;
    };
    expect(fbOpts.transcripts).toHaveLength(2);
    expect(fbOpts.transcripts?.map((t) => t.backend)).toEqual(
      expect.arrayContaining(['whisper-local', 'amazon-transcribe']),
    );
  });

  it('re-parse over multiple transcripts UPDATES the same Message (dedup), no duplicate', async () => {
    // Both transcripts of the same broadcast → same type + body → the
    // deterministic-id dedup links to one Message (#556/#454). The second
    // transcript carries `backend` and reconciles; it must not create a
    // second Message.
    const { client, getSpy, createSpy } = makeDataStub([
      { id: 'existing-msg', type: 'SKYKING', body: 'FOXTROT HOTEL' },
    ]);
    getSpy.mockResolvedValue({
      data: {
        id: 'rec',
        broadcastedAt: '2026-05-24T17:00:00Z',
        messageId: 'existing-msg',
        transcripts: [
          { backend: 'whisper-local', transcript: 'OXTRA HOTEL', ts: '2026-05-24T17:00:00Z' },
        ],
      },
      errors: null,
    });
    __setDeps({
      dataClient: client,
      rulesEngine: noRules,
      bedrockFallback: bedrockOk({ type: 'SKYKING', confidence: 0.95, body: 'FOXTROT HOTEL' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
      uuid: () => 'm',
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'FOXTROT HOTEL',
        backend: 'amazon-transcribe',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // Linked to the existing Message — no new Message created.
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('linguistic — re-run supersede + stable broadcast time (#556)', () => {
  /** Recording.get fixture carrying a prior messageId + broadcastedAt. */
  function recState(
    getSpy: ReturnType<typeof vi.fn>,
    state: { messageId?: string | null; broadcastedAt?: string | null },
  ): void {
    getSpy.mockResolvedValue({
      data: { id: 'rec', broadcastedAt: null, messageId: null, ...state },
      errors: null,
    });
  }

  it('persists broadcastedAt on the FIRST run when absent (stable time)', async () => {
    const { client, updateSpy } = makeDataStub();
    __setDeps({
      dataClient: client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'skyking do not answer' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec-first',
        transcript: 'skyking skyking do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // First run with no stored broadcastedAt → enqueuedAt is persisted so
    // the next run reuses it.
    expect(updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ broadcastedAt: '2026-05-24T17:55:00Z' }),
    );
  });

  it('reuses the stored broadcastedAt (does NOT re-persist) on a re-run', async () => {
    const stub = makeDataStub();
    // Stored broadcast time from the first run; the re-run carries a LATER
    // enqueuedAt that must be ignored for the deterministic id.
    recState(stub.getSpy, {
      messageId: 'm-same',
      broadcastedAt: '2026-05-24T13:00:00Z',
    });
    // M_old read for the supersede check — keep it a no-op delete target
    // so this test stays focused on the broadcast-time behaviour.
    stub.msgGetSpy.mockResolvedValue({
      data: { id: 'm-same', submitterId: null, deletedAt: null },
      errors: null,
    });
    stub.recByMsgSpy.mockResolvedValue({ data: [{ id: 'rec', deletedAt: null }], errors: null });
    __setDeps({
      dataClient: stub.client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'skyking do not answer' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'skyking skyking do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // Message is created with the STORED broadcast time, not the re-run
    // enqueuedAt — so an identical re-parse hits the same deterministic id.
    expect(stub.createSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ broadcastTs: '2026-05-24T13:00:00Z' }),
    );
    // The re-run does not overwrite the persisted broadcastedAt.
    expect(stub.updateSpy.mock.calls[1]?.[0]).not.toHaveProperty('broadcastedAt');
  });

  it('identical re-parse is idempotent: same Message id, no supersede', async () => {
    const stub = makeDataStub();
    // The dedup query returns the existing message so the Recording
    // re-links to it (same id) → priorMessageId === targetMessageId, and
    // the supersede path is never entered.
    stub.listSpy.mockResolvedValue({
      data: [{ id: 'm-existing', type: 'SKYKING', body: 'skyking do not answer' }],
      errors: null,
    });
    recState(stub.getSpy, {
      messageId: 'm-existing',
      broadcastedAt: '2026-05-24T13:00:00Z',
    });
    __setDeps({
      dataClient: stub.client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'skyking do not answer' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'skyking skyking do not answer',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // Re-linked to the same Message → no create, no supersede delete.
    expect(stub.createSpy).not.toHaveBeenCalled();
    expect(stub.msgUpdateSpy).not.toHaveBeenCalled();
  });

  it('soft-deletes M_old when it is single-audio + pipeline-created', async () => {
    const stub = makeDataStub();
    recState(stub.getSpy, {
      messageId: 'm-old',
      broadcastedAt: '2026-05-24T13:00:00Z',
    });
    // M_old: pipeline-created (no submitterId), not deleted.
    stub.msgGetSpy.mockResolvedValue({
      data: { id: 'm-old', submitterId: null, deletedAt: null },
      errors: null,
    });
    // Only this Recording references M_old.
    stub.recByMsgSpy.mockResolvedValue({
      data: [{ id: 'rec', deletedAt: null }],
      errors: null,
    });
    const auditSpy = vi.fn().mockResolvedValue('audit-1');
    __setDeps({
      dataClient: stub.client,
      audit: auditSpy,
      // New parse differs → new deterministic id ≠ m-old.
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'totally different body now' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'totally different body now',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    // M_old soft-deleted with deletedAt + audit.
    expect(stub.msgUpdateSpy).toHaveBeenCalledOnce();
    expect(stub.msgUpdateSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: 'm-old', deletedAt: '2026-05-24T18:00:00.000Z' }),
    );
    expect(auditSpy).toHaveBeenCalledOnce();
    expect(auditSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        action: 'MESSAGE_DELETE',
        targetType: 'Message',
        targetId: 'm-old',
      }),
    );
  });

  it('does NOT delete M_old when other Recordings reference it (multi-SDR)', async () => {
    const stub = makeDataStub();
    recState(stub.getSpy, {
      messageId: 'm-old',
      broadcastedAt: '2026-05-24T13:00:00Z',
    });
    stub.msgGetSpy.mockResolvedValue({
      data: { id: 'm-old', submitterId: null, deletedAt: null },
      errors: null,
    });
    // A sibling SDR capture still points at M_old.
    stub.recByMsgSpy.mockResolvedValue({
      data: [
        { id: 'rec', deletedAt: null },
        { id: 'rec-sibling', deletedAt: null },
      ],
      errors: null,
    });
    const auditSpy = vi.fn().mockResolvedValue('audit-1');
    __setDeps({
      dataClient: stub.client,
      audit: auditSpy,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'totally different body now' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'totally different body now',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(stub.msgUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('does NOT delete M_old when it was a recording-less / manual submission', async () => {
    const stub = makeDataStub();
    recState(stub.getSpy, {
      messageId: 'm-old',
      broadcastedAt: '2026-05-24T13:00:00Z',
    });
    // M_old carries a submitterId → recording-less / manual submission.
    stub.msgGetSpy.mockResolvedValue({
      data: { id: 'm-old', submitterId: 'user-sub-123', deletedAt: null },
      errors: null,
    });
    stub.recByMsgSpy.mockResolvedValue({
      data: [{ id: 'rec', deletedAt: null }],
      errors: null,
    });
    const auditSpy = vi.fn().mockResolvedValue('audit-1');
    __setDeps({
      dataClient: stub.client,
      audit: auditSpy,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'totally different body now' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'totally different body now',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(stub.msgUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('does NOT delete M_old when it is already soft-deleted', async () => {
    const stub = makeDataStub();
    recState(stub.getSpy, {
      messageId: 'm-old',
      broadcastedAt: '2026-05-24T13:00:00Z',
    });
    stub.msgGetSpy.mockResolvedValue({
      data: { id: 'm-old', submitterId: null, deletedAt: '2026-05-20T00:00:00Z' },
      errors: null,
    });
    const auditSpy = vi.fn().mockResolvedValue('audit-1');
    __setDeps({
      dataClient: stub.client,
      audit: auditSpy,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'totally different body now' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'totally different body now',
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(stub.msgUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('publishes the fresh Message even when the supersede check throws', async () => {
    const stub = makeDataStub();
    recState(stub.getSpy, {
      messageId: 'm-old',
      broadcastedAt: '2026-05-24T13:00:00Z',
    });
    stub.msgGetSpy.mockRejectedValue(new Error('ddb blip'));
    __setDeps({
      dataClient: stub.client,
      bedrockFallback: bedrockOk({ type: 'SKYKING', body: 'totally different body now' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      handler(
        makeEvent({
          recordingId: 'rec',
          transcript: 'totally different body now',
          enqueuedAt: '2026-05-24T17:55:00Z',
        }),
        {} as never,
        () => undefined,
      ),
    ).resolves.not.toThrow();
    // Fresh Message still created + Recording still PUBLISHED.
    expect(stub.createSpy).toHaveBeenCalledOnce();
    expect(stub.updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ transcriptionStatus: 'PUBLISHED' }),
    );
    errSpy.mockRestore();
  });
});

describe('linguistic — low-confidence Amazon Transcribe escalation (#588)', () => {
  /**
   * Build a data stub whose Recording.get returns a row with the source
   * media keys (+ optional transcripts collection / escalatedAt marker)
   * the escalation gate reads (#588).
   */
  function escalationStub(
    recOverrides: Record<string, unknown> = {},
    confidenceValue: unknown = null,
  ) {
    const stub = makeDataStub([], confidenceValue);
    stub.getSpy.mockResolvedValue({
      data: {
        id: 'rec',
        broadcastedAt: null,
        messageId: null,
        originalKey: 'recordings/originals/abc.wav',
        contentHash: 'h-abc',
        escalatedAt: null,
        transcripts: null,
        ...recOverrides,
      },
      errors: null,
    });
    return stub;
  }

  it('escalates ONCE to amazon-transcribe on a low-confidence whisper transcript', async () => {
    const stub = escalationStub();
    const escalateSpy = vi.fn((_msg: unknown) => Promise.resolve());
    __setDeps({
      dataClient: stub.client,
      escalate: escalateSpy,
      bedrockFallback: bedrockOk({ type: 'OTHER', body: 'mumble' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'mumble mumble',
        backend: 'whisper-local',
        transcriptionConfidence: 0.4, // below 0.6 default
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(escalateSpy).toHaveBeenCalledOnce();
    const escMsg = escalateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(escMsg).toEqual(
      expect.objectContaining({
        recordingId: 'rec',
        originalKey: 'recordings/originals/abc.wav',
        backendOverride: 'amazon-transcribe',
      }),
    );
    // contentHash is OMITTED on a re-transcribe (the recording already
    // exists; an empty-string dedup-key value would be a bug — see review).
    expect(escMsg).not.toHaveProperty('contentHash');
    // The escalatedAt loop-guard marker is persisted on the Recording.
    expect(stub.updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ escalatedAt: '2026-05-24T18:00:00.000Z' }),
    );
    // The current whisper Message still publishes (escalation is fire-and-forget).
    expect(stub.createSpy).toHaveBeenCalledOnce();
  });

  it('does NOT escalate a high-confidence whisper transcript', async () => {
    const stub = escalationStub();
    const escalateSpy = vi.fn((_msg: unknown) => Promise.resolve());
    __setDeps({
      dataClient: stub.client,
      escalate: escalateSpy,
      bedrockFallback: bedrockOk({ type: 'OTHER', body: 'clean' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'clean copy',
        backend: 'whisper-local',
        transcriptionConfidence: 0.92, // above 0.6
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(escalateSpy).not.toHaveBeenCalled();
    expect(stub.updateSpy.mock.calls[1]?.[0]).not.toHaveProperty('escalatedAt');
  });

  it('does NOT escalate when the recording is already escalated (escalatedAt marker)', async () => {
    const stub = escalationStub({ escalatedAt: '2026-05-24T17:00:00Z' });
    const escalateSpy = vi.fn((_msg: unknown) => Promise.resolve());
    __setDeps({
      dataClient: stub.client,
      escalate: escalateSpy,
      bedrockFallback: bedrockOk({ type: 'OTHER', body: 'mumble' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'mumble',
        backend: 'whisper-local',
        transcriptionConfidence: 0.3,
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(escalateSpy).not.toHaveBeenCalled();
  });

  it('does NOT escalate when an amazon-transcribe transcript already exists (no loop)', async () => {
    const stub = escalationStub({
      transcripts: [
        {
          backend: 'amazon-transcribe',
          transcript: 'prior transcribe pass',
          transcriptionConfidence: 0.5,
          ts: '2026-05-24T17:30:00Z',
        },
      ],
    });
    const escalateSpy = vi.fn((_msg: unknown) => Promise.resolve());
    __setDeps({
      dataClient: stub.client,
      escalate: escalateSpy,
      bedrockFallback: bedrockOk({ type: 'OTHER', body: 'mumble' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'mumble',
        backend: 'whisper-local',
        transcriptionConfidence: 0.3,
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(escalateSpy).not.toHaveBeenCalled();
  });

  it('does NOT escalate when the arriving transcript is itself amazon-transcribe (no bounce)', async () => {
    const stub = escalationStub();
    const escalateSpy = vi.fn((_msg: unknown) => Promise.resolve());
    __setDeps({
      dataClient: stub.client,
      escalate: escalateSpy,
      bedrockFallback: bedrockOk({ type: 'OTHER', body: 'mumble' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'mumble',
        backend: 'amazon-transcribe',
        transcriptionConfidence: 0.2, // low, but a Transcribe result never escalates
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(escalateSpy).not.toHaveBeenCalled();
  });

  it('respects an admin-tuned threshold from the LinguisticConfig row', async () => {
    // Threshold raised to 0.9 → a 0.7-confidence whisper transcript now escalates.
    const stub = escalationStub();
    (
      stub.configGetSpy as Mock<
        (input: { key: string }) => Promise<{ data: { value: number } | null; errors: null }>
      >
    ).mockImplementation(({ key }) => {
      return Promise.resolve({
        data: key === 'WHISPER_ESCALATION_THRESHOLD' ? { value: 0.9 } : null,
        errors: null,
      });
    });
    const escalateSpy = vi.fn((_msg: unknown) => Promise.resolve());
    __setDeps({
      dataClient: stub.client,
      escalate: escalateSpy,
      bedrockFallback: bedrockOk({ type: 'OTHER', body: 'mumble' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    await handler(
      makeEvent({
        recordingId: 'rec',
        transcript: 'borderline',
        backend: 'whisper-local',
        transcriptionConfidence: 0.7,
        enqueuedAt: '2026-05-24T17:55:00Z',
      }),
      {} as never,
      () => undefined,
    );
    expect(escalateSpy).toHaveBeenCalledOnce();
  });

  it('a failed escalation enqueue does NOT sink the current whisper publish', async () => {
    const stub = escalationStub();
    const escalateSpy = vi.fn(() => Promise.reject(new Error('SQS down')));
    __setDeps({
      dataClient: stub.client,
      escalate: escalateSpy,
      bedrockFallback: bedrockOk({ type: 'OTHER', body: 'mumble' }),
      now: () => new Date('2026-05-24T18:00:00Z'),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      handler(
        makeEvent({
          recordingId: 'rec',
          transcript: 'mumble',
          backend: 'whisper-local',
          transcriptionConfidence: 0.3,
          enqueuedAt: '2026-05-24T17:55:00Z',
        }),
        {} as never,
        () => undefined,
      ),
    ).resolves.not.toThrow();
    expect(escalateSpy).toHaveBeenCalledOnce();
    // Message still published; escalatedAt NOT persisted (enqueue failed).
    expect(stub.createSpy).toHaveBeenCalledOnce();
    expect(stub.updateSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ transcriptionStatus: 'PUBLISHED' }),
    );
    expect(stub.updateSpy.mock.calls[1]?.[0]).not.toHaveProperty('escalatedAt');
    errSpy.mockRestore();
  });
});

describe('rule dedup helpers (#575)', () => {
  it('ruleDedupKey ignores messageType and trims the pattern', () => {
    expect(ruleDedupKey('RECEIVER', 'ALLSTATIONS', '(?<receiver>all stations)  ')).toBe(
      ruleDedupKey('RECEIVER', 'ALLSTATIONS', '(?<receiver>all stations)'),
    );
  });

  it('distinguishes by component and appliesToType', () => {
    expect(ruleDedupKey('SENDER', 'SKYKING', 'x')).not.toBe(
      ruleDedupKey('RECEIVER', 'SKYKING', 'x'),
    );
    expect(ruleDedupKey('SENDER', 'SKYKING', 'x')).not.toBe(ruleDedupKey('SENDER', null, 'x'));
  });

  it('filterNewProposedRules drops rules matching the existing ruleset', () => {
    const existing = [{ component: 'TYPE', appliesToType: null, pattern: 'SKYKING' }];
    const proposed: ProposedRule[] = [
      { component: 'TYPE', pattern: 'SKYKING', confidence: 0.9 },
      { component: 'RECEIVER', appliesToType: 'SKYKING', pattern: 'all stations', confidence: 0.8 },
    ];
    const out = filterNewProposedRules(proposed, existing);
    expect(out.map((r) => r.component)).toEqual(['RECEIVER']);
  });

  it('filterNewProposedRules dedups within the batch itself', () => {
    const proposed: ProposedRule[] = [
      { component: 'TYPE', pattern: 'SKYKING', confidence: 0.9 },
      { component: 'TYPE', pattern: 'SKYKING', confidence: 0.7 },
    ];
    expect(filterNewProposedRules(proposed, [])).toHaveLength(1);
  });
});
