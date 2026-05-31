import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetVocabularyCommand,
  CreateVocabularyCommand,
} from '@aws-sdk/client-transcribe';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
 *   2. Best-effort ensure the table-format custom vocabulary exists:
 *      build the term table (BASE_VOCAB ∪ BASE_PROWORDS ∪ callsigns)
 *      + its hash (`vocab.ts`), `GetVocabulary` by the hash-derived
 *      name, and on a 404 upload the table TSV to S3 + `CreateVocabulary`
 *      from `VocabularyFileUri`. Vocab is purely a quality boost — any
 *      failure here is swallowed and the job runs WITHOUT a custom vocab
 *      so a DDB hiccup or vocab-state race never blocks transcription.
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
  /** S3 client — uploads the table-format vocab TSV for `VocabularyFileUri`. */
  s3?: S3Client;
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

let cachedS3: S3Client | undefined;
function s3Client(): S3Client {
  return injected.s3 ?? (cachedS3 ??= new S3Client({}));
}

/**
 * Validates the dispatch message. Returns `null` (caller throws) when
 * a required field is missing so a malformed upstream message fails
 * loud instead of issuing a Transcribe job against an empty key.
 *
 * Audio key resolution (#587): the canonical transcribe-queue message
 * the dispatcher forwards is `{recordingId, originalKey, contentHash,
 * enqueuedAt}` (published by the preprocess Lambda). Amazon Transcribe
 * decodes the ORIGINAL upload natively for max quality, so `originalKey`
 * is the preferred media source. An explicit `audioKey` (e.g. an admin
 * re-run on the web-canonical derivative) still wins when present.
 */
export function parseDispatchMessage(raw: unknown): DispatchMessage | null {
  // Robust to BOTH payload shapes (#589 review): the dispatcher
  // Event-invokes this Lambda and AWS already JSON-parses the invoke
  // Payload, so `raw` is normally the dispatch OBJECT. But a direct
  // invoke that forwards the raw SQS body (a JSON string) must not crash
  // the handler — accept a string by parsing it first. A bad string is
  // swallowed to `null` (caller throws) rather than throwing here.
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.recordingId !== 'string' || obj.recordingId.trim() === '') return null;
  const audioKey =
    typeof obj.audioKey === 'string' && obj.audioKey.trim() !== ''
      ? obj.audioKey
      : typeof obj.originalKey === 'string' && obj.originalKey.trim() !== ''
        ? obj.originalKey
        : null;
  if (!audioKey) return null;
  return {
    recordingId: obj.recordingId,
    audioKey,
    enqueuedAt: typeof obj.enqueuedAt === 'string' ? obj.enqueuedAt : undefined,
  };
}

/**
 * Best-effort custom-vocabulary ensure. Returns the vocab name to set
 * on the job, or `undefined` when there is no usable vocab (any failure
 * along the way — vocab is a nice-to-have, never a blocker).
 *
 * Uses Transcribe's TABLE format (`VocabularyFileUri`) so multi-word
 * EAM prowords ("do not answer", …) are biasable: the table TSV from
 * `computeVocabHash().tableTsv` is uploaded to S3, then
 * `CreateVocabulary` is created from it. `CreateVocabulary` is async
 * server-side (PENDING → READY), so the creating job runs without the
 * vocab; the next job for the same term-set hash reuses the now-READY
 * vocab.
 */
async function ensureVocabulary(): Promise<string | undefined> {
  try {
    const loader = injected.loadCallsigns ?? loadCallsignsFromDdb;
    const loaded = await loader();
    // An empty / failed callsign load is fine — the term table still
    // unions the static BASE_VOCAB + BASE_PROWORDS, so the vocab is
    // worthwhile even before any callsign is seeded.
    const callsigns = Array.isArray(loaded) ? loaded : [];

    const vocab = computeVocabHash(callsigns);
    // Defensive: the base set is non-empty, so this never trips today —
    // guards a future where someone empties the base constants.
    if (vocab.rows.length === 0) return undefined;

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
      // 404 → first time we've seen this term-set hash; create it.
      if (isNotFound(err)) {
        const bucket = process.env.RECORDINGS_BUCKET;
        if (!bucket) {
          // No bucket to stage the table TSV → can't create a table-
          // format vocab. Skip (best-effort) rather than throw.
          console.warn('transcribe-aws: RECORDINGS_BUCKET unset; cannot stage vocab table', {
            vocabName: vocab.vocabName,
          });
          return undefined;
        }
        const tempPrefix = process.env.PIPELINE_TEMP_PREFIX ?? 'pipeline-temp';
        // Hash-named so the table object is content-addressed + stable;
        // lives under pipeline-temp (7-day lifecycle) — Transcribe reads
        // it once at CreateVocabulary time, so transient is fine.
        const vocabFileKey = `${tempPrefix}/vocab/${vocab.short}.tsv`;
        await s3Client().send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: vocabFileKey,
            Body: vocab.tableTsv,
            ContentType: 'text/tab-separated-values',
          }),
        );
        await client.send(
          new CreateVocabularyCommand({
            VocabularyName: vocab.vocabName,
            LanguageCode: 'en-US',
            VocabularyFileUri: `s3://${bucket}/${vocabFileKey}`,
          }),
        );
        console.info('transcribe-aws: created table-format custom vocab (PENDING)', {
          vocabName: vocab.vocabName,
          rows: vocab.rows.length,
          vocabFileKey,
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

// Warm-container TTL cache for the callsign Scan — `ensureVocabulary`
// runs every invoke, so without this a busy container re-Scans the
// (tiny, slow-changing) Callsign table on every recording. 5-minute
// TTL bounds staleness: a freshly-added callsign reaches the vocab
// within one TTL window, which is fine for a hand-curated dictionary.
// Mirrors the cache-per-cold-load intent of `load-rules-ddb.ts`.
const CALLSIGN_CACHE_TTL_MS = 5 * 60 * 1000;
let callsignCache: { value: string[]; expiresAt: number } | undefined;

export function __resetCallsignCache(): void {
  callsignCache = undefined;
}

/**
 * Production callsign loader — Scans the `Callsign` DDB table for
 * approved entries and returns their `normalized` values (plus any
 * `variants`) for the custom vocabulary. Bounded table (hand-curated
 * dictionary), so a Scan is the right shape; matches the
 * `load-rules-ddb.ts` precedent. `CALLSIGN_TABLE_NAME` env var wires
 * the table at synth time. Returns `[]` (vocab skipped) when the env
 * var is unset so a sandbox without the wiring still transcribes.
 * Result is cached per warm container for `CALLSIGN_CACHE_TTL_MS`.
 */
async function loadCallsignsFromDdb(): Promise<string[]> {
  const table = process.env.CALLSIGN_TABLE_NAME;
  if (!table) return [];
  const now = Date.now();
  if (callsignCache && callsignCache.expiresAt > now) return callsignCache.value;
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
  callsignCache = { value: out, expiresAt: now + CALLSIGN_CACHE_TTL_MS };
  return out;
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  const httpStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NotFoundException' || httpStatus === 404;
}
