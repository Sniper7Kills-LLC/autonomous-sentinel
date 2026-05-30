import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetVocabularyCommand,
  CreateVocabularyCommand,
} from '@aws-sdk/client-transcribe';
import { DynamoDBClient, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { computeVocabHash } from './vocab';
import { buildJobName } from './job-name';

/**
 * Amazon Transcribe backend Lambda — backend (c) (#585, epic #582).
 *
 * Per CLAUDE.md → Pipeline components → Transcribe Lambda this is the
 * `amazon-transcribe` pluggable backend. It is invoked with a single
 * dispatch message `{recordingId, audioKey, enqueuedAt}` (Event
 * invocation from the #582b dispatcher once that lands; until then the
 * Lambda is deployable-but-unsubscribed — see `backend.ts`).
 *
 * Steps per invoke:
 *   1. Parse + validate the dispatch message.
 *   2. Best-effort ensure the custom vocabulary exists: compute a
 *      stable hash from the callsign dictionary (`vocab.ts`),
 *      `GetVocabulary` by the hash-derived name, `CreateVocabulary`
 *      on a 404. Vocab is purely a quality boost — any failure here
 *      is swallowed and the job runs WITHOUT a custom vocab so a DDB
 *      hiccup or vocab-state race never blocks transcription.
 *   3. `StartTranscriptionJob` against the recording audio in S3
 *      (`s3://<RECORDINGS_BUCKET>/<audioKey>`), language `en-US`,
 *      output to `pipeline-temp/<recordingId>/transcribe.json`, job
 *      name embeds the recordingId so the async finalizer can map a
 *      "Transcribe Job State Change" event back to the Recording.
 *   4. Return — never poll for completion (the finalizer owns that).
 *
 * Audio source: the issue specifies the ORIGINAL upload for max
 * quality (Transcribe decodes wav/mp3/ogg/flac/etc natively). The
 * dispatcher passes the original key as `audioKey`; we do not assume
 * a fixed prefix here.
 *
 * Test seam: `__setDeps({ transcribe, loadCallsigns })` injects a
 * stubbed TranscribeClient + an in-memory callsign loader so vitest
 * never touches AWS — mirrors the `opts.client` seam on
 * `linguistic/ai-fallback.ts`.
 */

export interface DispatchMessage {
  recordingId: string;
  audioKey: string;
  enqueuedAt?: string;
}

export interface TranscribeAwsDeps {
  transcribe?: TranscribeClient;
  /** Loads the callsign dictionary for the custom vocabulary. */
  loadCallsigns?: () => Promise<string[]>;
  /** Injectable clock / randomness for deterministic job names in tests. */
  now?: () => number;
  rand?: () => number;
}

let injected: TranscribeAwsDeps = {};

export function __setDeps(deps: TranscribeAwsDeps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedTranscribe: TranscribeClient | undefined;
function transcribeClient(): TranscribeClient {
  return injected.transcribe ?? (cachedTranscribe ??= new TranscribeClient({}));
}

/**
 * Validates the dispatch message. Returns `null` (caller throws) when
 * a required field is missing so a malformed upstream message fails
 * loud instead of issuing a Transcribe job against an empty key.
 */
export function parseDispatchMessage(raw: unknown): DispatchMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.recordingId !== 'string' || obj.recordingId.trim() === '') return null;
  if (typeof obj.audioKey !== 'string' || obj.audioKey.trim() === '') return null;
  return {
    recordingId: obj.recordingId,
    audioKey: obj.audioKey,
    enqueuedAt: typeof obj.enqueuedAt === 'string' ? obj.enqueuedAt : undefined,
  };
}

/**
 * Best-effort custom-vocabulary ensure. Returns the vocab name to set
 * on the job, or `undefined` when there is no usable vocab (empty
 * dictionary, or any failure along the way — vocab is a nice-to-have).
 */
async function ensureVocabulary(): Promise<string | undefined> {
  try {
    const loader = injected.loadCallsigns ?? loadCallsignsFromDdb;
    const callsigns = await loader();
    if (!Array.isArray(callsigns) || callsigns.length === 0) return undefined;

    const vocab = computeVocabHash(callsigns);
    if (vocab.canonicalised.length === 0) return undefined;

    const client = transcribeClient();
    try {
      const got = await client.send(new GetVocabularyCommand({ VocabularyName: vocab.vocabName }));
      // A vocab still PENDING is not yet usable; skip it for this job
      // rather than risk a `BadRequestException: vocab not READY`.
      if (got.VocabularyState && got.VocabularyState !== 'READY') {
        console.warn('transcribe-aws: custom vocab not READY yet; running without it', {
          vocabName: vocab.vocabName,
          state: got.VocabularyState,
        });
        return undefined;
      }
      return vocab.vocabName;
    } catch (err) {
      // 404 → first time we've seen this dictionary hash; create it.
      // `CreateVocabulary` is async server-side (state PENDING → READY),
      // so this job runs without the vocab; the NEXT job for the same
      // dictionary reuses the now-READY vocab. That one-job warm-up cost
      // is acceptable vs blocking the pipeline waiting for READY.
      if (isNotFound(err)) {
        await client.send(
          new CreateVocabularyCommand({
            VocabularyName: vocab.vocabName,
            LanguageCode: 'en-US',
            Phrases: vocab.canonicalised,
          }),
        );
        console.info('transcribe-aws: created custom vocab (PENDING); first job runs without it', {
          vocabName: vocab.vocabName,
          phrases: vocab.canonicalised.length,
        });
        return undefined;
      }
      throw err;
    }
  } catch (err) {
    console.warn('transcribe-aws: vocab ensure failed; transcribing without custom vocab', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Handler entrypoint. Accepts the dispatch message directly (the
 * #582b dispatcher Event-invokes this Lambda with the message as the
 * payload). Throws on a malformed message or missing config so the
 * invoker's retry path engages.
 */
export async function handler(event: DispatchMessage): Promise<{ jobName: string }> {
  const bucket = process.env.RECORDINGS_BUCKET;
  if (!bucket) {
    throw new Error('transcribe-aws: RECORDINGS_BUCKET env var is unset');
  }
  const tempPrefix = process.env.PIPELINE_TEMP_PREFIX ?? 'pipeline-temp';

  const msg = parseDispatchMessage(event);
  if (!msg) {
    throw new Error('transcribe-aws: malformed dispatch message (recordingId + audioKey required)');
  }

  const vocabName = await ensureVocabulary();

  const jobName = buildJobName(msg.recordingId, { now: injected.now, rand: injected.rand });
  const outputKey = `${tempPrefix}/${msg.recordingId}/transcribe.json`;

  await transcribeClient().send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: 'en-US',
      Media: { MediaFileUri: `s3://${bucket}/${msg.audioKey}` },
      OutputBucketName: bucket,
      OutputKey: outputKey,
      ...(vocabName ? { Settings: { VocabularyName: vocabName } } : {}),
    }),
  );

  console.info('transcribe-aws: started transcription job', {
    recordingId: msg.recordingId,
    jobName,
    audioKey: msg.audioKey,
    outputKey,
    vocabName: vocabName ?? '(none)',
  });

  return { jobName };
}

/* ----- production callsign loader -------------------------------- */

let cachedDdb: DynamoDBClient | undefined;
function ddb(): DynamoDBClient {
  return (cachedDdb ??= new DynamoDBClient({}));
}

/**
 * Production callsign loader — Scans the `Callsign` DDB table for
 * approved entries and returns their `normalized` values (plus any
 * `variants`) for the custom vocabulary. Bounded table (hand-curated
 * dictionary), so a Scan is the right shape; matches the
 * `load-rules-ddb.ts` precedent. `CALLSIGN_TABLE_NAME` env var wires
 * the table at synth time. Returns `[]` (vocab skipped) when the env
 * var is unset so a sandbox without the wiring still transcribes.
 */
async function loadCallsignsFromDdb(): Promise<string[]> {
  const table = process.env.CALLSIGN_TABLE_NAME;
  if (!table) return [];
  const out: string[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await ddb().send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: '#n, variants, approved',
        ExpressionAttributeNames: { '#n': 'normalized' },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const row = unmarshall(item) as {
        normalized?: string;
        variants?: string[];
        approved?: boolean;
      };
      // `approved` defaults to true on the model; treat an absent flag
      // as approved, only skip explicit `false`.
      if (row.approved === false) continue;
      if (typeof row.normalized === 'string') out.push(row.normalized);
      if (Array.isArray(row.variants)) {
        for (const v of row.variants) if (typeof v === 'string') out.push(v);
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  const httpStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NotFoundException' || httpStatus === 404;
}
