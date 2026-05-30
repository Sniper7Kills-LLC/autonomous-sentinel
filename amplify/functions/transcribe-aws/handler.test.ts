import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetVocabularyCommand,
  CreateVocabularyCommand,
} from '@aws-sdk/client-transcribe';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import {
  handler,
  parseDispatchMessage,
  __setDeps,
  __resetDeps,
  __resetCallsignCache,
} from './handler';
import { recordingIdFromJobName } from './job-name';
import { computeVocabHash } from './vocab';

/**
 * transcribe-aws backend Lambda contract (#585):
 *
 *   dispatch message `{recordingId, audioKey, enqueuedAt}` →
 *     ensure custom vocab (Get / Create from callsign dictionary) →
 *     StartTranscriptionJob(en-US, MediaFileUri=s3 audioKey,
 *       OutputBucket=recordings bucket, OutputKey=pipeline-temp/<id>/transcribe.json,
 *       job name embeds recordingId)
 *
 *   No wait for completion — the EventBridge finalizer picks the job up.
 */

const transcribeMock = mockClient(TranscribeClient);
const ddbMock = mockClient(DynamoDBClient);

const ENV = {
  RECORDINGS_BUCKET: 'media-bucket',
  PIPELINE_TEMP_PREFIX: 'pipeline-temp',
};

function setEnv() {
  process.env.RECORDINGS_BUCKET = ENV.RECORDINGS_BUCKET;
  process.env.PIPELINE_TEMP_PREFIX = ENV.PIPELINE_TEMP_PREFIX;
}

beforeEach(() => {
  transcribeMock.reset();
  ddbMock.reset();
  setEnv();
  __resetDeps();
  __resetCallsignCache();
  delete process.env.CALLSIGN_TABLE_NAME;
});

describe('parseDispatchMessage', () => {
  it('parses a well-formed dispatch message', () => {
    const msg = parseDispatchMessage({
      recordingId: 'rec-1',
      audioKey: 'recordings/originals/rec-1.wav',
      enqueuedAt: '2026-05-30T00:00:00Z',
    });
    expect(msg).toEqual({
      recordingId: 'rec-1',
      audioKey: 'recordings/originals/rec-1.wav',
      enqueuedAt: '2026-05-30T00:00:00Z',
    });
  });

  it('rejects a message missing recordingId or audioKey', () => {
    expect(parseDispatchMessage({ audioKey: 'k' })).toBeNull();
    expect(parseDispatchMessage({ recordingId: 'r' })).toBeNull();
    expect(parseDispatchMessage(null)).toBeNull();
  });
});

describe('handler — StartTranscriptionJob', () => {
  it('starts a job with en-US, S3 media uri, pipeline-temp output, and embeds recordingId in the job name', async () => {
    transcribeMock.on(GetVocabularyCommand).rejects(notFound());
    transcribeMock.on(CreateVocabularyCommand).resolves({});
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});

    __setDeps({ loadCallsigns: () => Promise.resolve(['SKYKING', 'MAINSAIL']) });

    await handler({
      recordingId: 'rec-abc',
      audioKey: 'recordings/originals/rec-abc.wav',
      enqueuedAt: '2026-05-30T00:00:00Z',
    });

    const calls = transcribeMock.commandCalls(StartTranscriptionJobCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.LanguageCode).toBe('en-US');
    expect(input.Media?.MediaFileUri).toBe('s3://media-bucket/recordings/originals/rec-abc.wav');
    expect(input.OutputBucketName).toBe('media-bucket');
    expect(input.OutputKey).toBe('pipeline-temp/rec-abc/transcribe.json');
    expect(typeof input.TranscriptionJobName).toBe('string');
    expect(recordingIdFromJobName(input.TranscriptionJobName)).toBe('rec-abc');
  });

  it('creates the custom vocabulary when GetVocabulary 404s; first job warms up without it (vocab is async PENDING)', async () => {
    transcribeMock.on(GetVocabularyCommand).rejects(notFound());
    transcribeMock.on(CreateVocabularyCommand).resolves({});
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});

    const callsigns = ['SKYKING', 'MAINSAIL'];
    __setDeps({ loadCallsigns: () => Promise.resolve(callsigns) });

    await handler({ recordingId: 'rec-1', audioKey: 'k.wav', enqueuedAt: 't' });

    const created = transcribeMock.commandCalls(CreateVocabularyCommand);
    expect(created).toHaveLength(1);
    const expectedVocab = computeVocabHash(callsigns);
    expect(created[0]!.args[0].input.VocabularyName).toBe(expectedVocab.vocabName);
    expect(created[0]!.args[0].input.LanguageCode).toBe('en-US');
    expect(created[0]!.args[0].input.Phrases).toEqual(expectedVocab.canonicalised);

    // CreateVocabulary returns PENDING server-side; referencing a
    // not-READY vocab makes StartTranscriptionJob throw. So the
    // creating job runs WITHOUT the vocab — the next job (now READY)
    // picks it up (asserted by the READY-reuse test below).
    const job = transcribeMock.commandCalls(StartTranscriptionJobCommand)[0]!.args[0].input;
    expect(job.Settings?.VocabularyName).toBeUndefined();
  });

  it('reuses an existing READY vocabulary without re-creating it', async () => {
    transcribeMock.on(GetVocabularyCommand).resolves({ VocabularyState: 'READY' });
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});

    __setDeps({ loadCallsigns: () => Promise.resolve(['SKYKING']) });
    await handler({ recordingId: 'rec-2', audioKey: 'k.wav', enqueuedAt: 't' });

    expect(transcribeMock.commandCalls(CreateVocabularyCommand)).toHaveLength(0);
    const job = transcribeMock.commandCalls(StartTranscriptionJobCommand)[0]!.args[0].input;
    expect(job.Settings?.VocabularyName).toBe(computeVocabHash(['SKYKING']).vocabName);
  });

  it('proceeds WITHOUT a vocabulary when vocab loading / ensuring fails (best-effort)', async () => {
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});
    __setDeps({
      loadCallsigns: () => Promise.reject(new Error('ddb down')),
    });

    await handler({ recordingId: 'rec-3', audioKey: 'k.wav', enqueuedAt: 't' });

    const job = transcribeMock.commandCalls(StartTranscriptionJobCommand)[0]!.args[0].input;
    expect(job.Settings?.VocabularyName).toBeUndefined();
    expect(transcribeMock.commandCalls(StartTranscriptionJobCommand)).toHaveLength(1);
  });

  it('skips vocab entirely when the callsign dictionary is empty', async () => {
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});
    __setDeps({ loadCallsigns: () => Promise.resolve([]) });

    await handler({ recordingId: 'rec-4', audioKey: 'k.wav', enqueuedAt: 't' });

    expect(transcribeMock.commandCalls(GetVocabularyCommand)).toHaveLength(0);
    expect(transcribeMock.commandCalls(CreateVocabularyCommand)).toHaveLength(0);
    const job = transcribeMock.commandCalls(StartTranscriptionJobCommand)[0]!.args[0].input;
    expect(job.Settings?.VocabularyName).toBeUndefined();
  });

  it('throws on a malformed dispatch message so SQS / invoker can redrive', async () => {
    __setDeps({ loadCallsigns: () => Promise.resolve([]) });
    await expect(handler({ audioKey: 'k' } as never)).rejects.toThrow();
  });

  it('throws when RECORDINGS_BUCKET is unset', async () => {
    delete process.env.RECORDINGS_BUCKET;
    __setDeps({ loadCallsigns: () => Promise.resolve([]) });
    await expect(handler({ recordingId: 'r', audioKey: 'k.wav', enqueuedAt: 't' })).rejects.toThrow(
      /RECORDINGS_BUCKET/,
    );
  });
});

describe('handler — production Callsign loader (no injected loadCallsigns)', () => {
  it('Scans the Callsign table, includes variants, skips unapproved, and caches per warm container', async () => {
    process.env.CALLSIGN_TABLE_NAME = 'Callsign-table';
    ddbMock.on(ScanCommand).resolves({
      Items: [
        marshall({ normalized: 'SKYKING', variants: ['SKY KING'], approved: true }),
        marshall({ normalized: 'MAINSAIL', approved: false }), // skipped
        marshall({ normalized: 'CYBORG' }), // approved absent → included
      ],
    });
    transcribeMock.on(GetVocabularyCommand).resolves({ VocabularyState: 'READY' });
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});

    await handler({ recordingId: 'rec-ddb', audioKey: 'k.wav', enqueuedAt: 't' });

    // SKYKING + SKY KING + CYBORG (MAINSAIL excluded as unapproved).
    const expected = computeVocabHash(['SKYKING', 'SKY KING', 'CYBORG']);
    const job = transcribeMock.commandCalls(StartTranscriptionJobCommand)[0]!.args[0].input;
    expect(job.Settings?.VocabularyName).toBe(expected.vocabName);
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);

    // Second invoke reuses the warm-container cache — no second Scan.
    await handler({ recordingId: 'rec-ddb-2', audioKey: 'k.wav', enqueuedAt: 't' });
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  it('skips vocab (no Scan) when CALLSIGN_TABLE_NAME is unset', async () => {
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});
    await handler({ recordingId: 'rec-noenv', audioKey: 'k.wav', enqueuedAt: 't' });
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
    const job = transcribeMock.commandCalls(StartTranscriptionJobCommand)[0]!.args[0].input;
    expect(job.Settings?.VocabularyName).toBeUndefined();
  });
});

function notFound(): Error {
  const err = new Error('not found') as Error & { name: string };
  err.name = 'NotFoundException';
  return err;
}
