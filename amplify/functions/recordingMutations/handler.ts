import type { AppSyncResolverHandler } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client, DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';
import {
  DEFAULT_TRANSCRIBE_BACKEND,
  isTranscribeBackend,
  type TranscribeBackend,
} from '../transcribe-dispatch/selector';

/**
 * Lambda-backed AppSync resolver for Recording custom mutations
 * (#29 / #284). Cross-cutting AuditLog helper (#258) is the sole
 * writer of the `RECORDING_*` audit rows.
 *
 * Dispatches on `event.info.fieldName`:
 *   - `softDeleteRecording` — admin-only. Sets `deletedAt` /
 *     `deletedBy` on the Recording row. Idempotent — a second call
 *     on an already-deleted row returns the row untouched.
 *   - `submitRecording` — authenticated. Enforces `contentHash`
 *     uniqueness server-side (#284): Queries the
 *     `recording-contentHash-index` GSI; if any row with the same
 *     hash exists (deleted or not), throws
 *     `RECORDING_DUPLICATE_HASH`. Otherwise creates the row with
 *     `uploaderId` set from `ctx.identity.sub` (never trusted from
 *     the client).
 *
 * Recording carries no `deletedReason` column at the row level (per
 * the model definition in #257); the moderator's reason is captured
 * only on the AuditLog entry.
 *
 * No cascade to the parent Message. The original CLAUDE.md rule
 * ("messages with no recording cease to exist") was reversed when
 * we discovered the v3 archive has Messages with no Recording for
 * analytics + the v4 submission flow will allow recording-less
 * entries gated by a verification step (anti-spam). A Recording
 * delete therefore touches only the Recording row.
 *
 *   - `restoreRecording` — admin-only. Reverses a soft-delete: clears
 *     `deletedAt`/`deletedBy` + removes the S3 delete-markers (#478).
 *
 * S3 hard-delete (#478): `softDeleteRecording` issues DeleteObject on the
 * recording's `originalKey` / `webCanonicalKey` / `wordTimestampsKey` /
 * `peaksJsonKey` after the row update. Bucket versioning turns each into a
 * recoverable delete-marker; the keys touched land on the audit `after`.
 *
 * Returns the post-mutation Recording row.
 */

export type RecordingRow = {
  id: string;
  messageId?: string | null;
  uploaderId?: string | null;
  contentHash?: string | null;
  originalKey?: string | null;
  webCanonicalKey?: string | null;
  durationMs?: number | null;
  frequencyKhz?: number | null;
  modulation?: 'USB' | 'LSB' | 'AM' | 'FM' | null;
  broadcastedAt?: string | null;
  automated?: boolean | null;
  sdrId?: string | null;
  transcriptionStatus?: string | null;
  transcriptionFailed?: boolean | null;
  migratedFromV3?: boolean | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  [k: string]: unknown;
};

export interface RecordingMutationsDataClient {
  models: {
    Recording: {
      get: (input: { id: string }) => Promise<{
        data: RecordingRow | null;
        errors?: unknown;
      }>;
      create: (input: Omit<RecordingRow, 'id'>) => Promise<{
        data: RecordingRow | null;
        errors?: unknown;
      }>;
      update: (
        input: Partial<RecordingRow> & { id: string },
      ) => Promise<{ data: RecordingRow | null; errors?: unknown }>;
      /**
       * GSI lookup auto-generated for `i('contentHash')` on Recording
       * (#257). Used by `submitRecording` (#284) to reject duplicate
       * uploads with the same SHA-256.
       */
      listRecordingByContentHash: (input: { contentHash: string }) => Promise<{
        data: RecordingRow[] | null;
        errors?: unknown;
      }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

/**
 * `enqueuePreprocess` publishes the freshly-created Recording id to the
 * preprocess SQS queue so the preprocess Lambda can start the pipeline
 * (#433). Default implementation uses the AWS SDK against the queue
 * URL in `PREPROCESS_QUEUE_URL`. Override in tests to assert the
 * payload shape without spinning the SDK up.
 *
 * Failure to publish does NOT roll back the Recording row — the row is
 * the audit-of-record; a missed enqueue can be redriven by an
 * operator (or eventually a janitor). The handler logs and proceeds.
 */
export type EnqueuePreprocessFn = (msg: PreprocessQueueMessage) => Promise<void>;

export interface PreprocessQueueMessage {
  recordingId: string;
  originalKey: string;
  contentHash: string;
  enqueuedAt: string;
  /**
   * Per-recording transcribe-backend override (#592). When set, the
   * preprocess Lambda forwards it onto the transcribe-queue message so
   * the dispatcher (#587/#589) routes this recording to the chosen
   * backend. Absent on a normal upload (the dispatcher then uses the
   * env-wide admin default / `whisper-local`).
   */
  backendOverride?: TranscribeBackend;
}

/**
 * `enqueueLinguistic` publishes a transcript message straight onto the
 * linguistic SQS queue (#566 `reparseRecording`), skipping the
 * preprocess + transcribe stages. The payload is the same
 * `TranscriptQueueMessage` shape the linguistic Lambda already consumes,
 * so the existing classifier / dedup path runs unchanged. Default
 * implementation publishes via the AWS SDK against `LINGUISTIC_QUEUE_URL`.
 */
export type EnqueueLinguisticFn = (msg: TranscriptQueueMessage) => Promise<void>;

/**
 * Linguistic-stage queue message (re-parse). Mirrors the
 * `TranscriptQueueMessage` the Whisper container publishes + the
 * linguistic Lambda parses. `kind: 'transcript'` is explicit so the
 * linguistic handler routes it to `processTranscript`.
 */
export interface TranscriptQueueMessage {
  kind: 'transcript';
  recordingId: string;
  transcript: string;
  enqueuedAt: string;
}

/**
 * S3 side-effects for Recording hard-delete / restore (#478). Injected in
 * tests so the delete/restore wiring is asserted without a live bucket.
 *
 * `deleteObject` issues a plain DeleteObject — on a version-enabled bucket
 * (storage-lifecycle.ts) that writes a delete-marker, so the prior version
 * stays restorable for the 30-day noncurrent-version window.
 * `restoreObject` reverses it by deleting the latest delete-marker version
 * for the key (resolved via ListObjectVersions); a no-op if none exists.
 */
export interface RecordingS3 {
  deleteObject(key: string): Promise<void>;
  restoreObject(key: string): Promise<void>;
}

interface Deps {
  dataClient?: RecordingMutationsDataClient;
  audit?: AuditFn;
  now?: () => Date;
  enqueuePreprocess?: EnqueuePreprocessFn;
  enqueueLinguistic?: EnqueueLinguisticFn;
  s3?: RecordingS3;
}

/** Recording S3-key columns whose objects are hard-deleted / restored (#478). */
const RECORDING_KEY_FIELDS = [
  'originalKey',
  'webCanonicalKey',
  'wordTimestampsKey',
  'peaksJsonKey',
] as const;

/** Collect the non-empty S3 keys referenced by a Recording row. */
export function recordingS3Keys(row: RecordingRow): string[] {
  const keys: string[] = [];
  for (const field of RECORDING_KEY_FIELDS) {
    const v = row[field];
    if (typeof v === 'string' && v.length > 0) keys.push(v);
  }
  return keys;
}

let injected: Deps = {};

export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedDefaultClient: RecordingMutationsDataClient | undefined;

async function getDefaultClient(): Promise<RecordingMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  // Lambda runtime has no auto-config — call `Amplify.configure(...)`
  // before `generateClient()` or it throws. See
  // `amplify/functions/_shared/configure-amplify.ts` for the helper.
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as RecordingMutationsDataClient;
  return cachedDefaultClient;
}

let cachedSqsClient: SQSClient | undefined;
function getSqsClient(): SQSClient {
  if (!cachedSqsClient) cachedSqsClient = new SQSClient({});
  return cachedSqsClient;
}

let cachedS3Client: S3Client | undefined;
function getS3Client(): S3Client {
  if (!cachedS3Client) cachedS3Client = new S3Client({});
  return cachedS3Client;
}

function requireMediaBucket(): string {
  const v = process.env.MEDIA_BUCKET_NAME;
  if (!v) {
    throw new Error(
      'recordingMutations: MEDIA_BUCKET_NAME env var is required for S3 delete/restore',
    );
  }
  return v;
}

/**
 * Production {@link RecordingS3}. `deleteObject` relies on bucket
 * versioning to turn the delete into a recoverable delete-marker;
 * `restoreObject` finds the latest delete-marker version for the key and
 * removes it, exposing the prior real version again.
 */
const defaultS3: RecordingS3 = {
  async deleteObject(key) {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: requireMediaBucket(), Key: key }));
  },
  async restoreObject(key) {
    const bucket = requireMediaBucket();
    const listed = await getS3Client().send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
    );
    // ListObjectVersions returns versions for every key sharing the prefix;
    // match the exact key and take the current delete-marker.
    const marker = (listed.DeleteMarkers ?? []).find((m) => m.Key === key && m.IsLatest);
    if (!marker?.VersionId) return; // nothing to restore — not currently delete-marked
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: marker.VersionId }),
    );
  },
};

/**
 * Production implementation of {@link EnqueuePreprocessFn}. Reads the
 * queue URL from the `PREPROCESS_QUEUE_URL` env var (wired by
 * `amplify/backend.ts` against `pipelineQueues.preprocess.main.queueUrl`).
 */
async function defaultEnqueuePreprocess(msg: PreprocessQueueMessage): Promise<void> {
  const queueUrl = process.env.PREPROCESS_QUEUE_URL;
  if (!queueUrl) {
    console.warn('submitRecording: PREPROCESS_QUEUE_URL unset — pipeline kick-off skipped', {
      recordingId: msg.recordingId,
    });
    return;
  }
  await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(msg),
    }),
  );
}

/**
 * Production implementation of {@link EnqueueLinguisticFn}. Reads the
 * queue URL from `LINGUISTIC_QUEUE_URL` (wired in `amplify/backend.ts`
 * against `pipelineQueues.linguistic.main.queueUrl`).
 */
async function defaultEnqueueLinguistic(msg: TranscriptQueueMessage): Promise<void> {
  const queueUrl = process.env.LINGUISTIC_QUEUE_URL;
  if (!queueUrl) {
    console.warn('reparseRecording: LINGUISTIC_QUEUE_URL unset — re-parse enqueue skipped', {
      recordingId: msg.recordingId,
    });
    return;
  }
  await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(msg),
    }),
  );
}

function hasGroup(identity: unknown, group: string): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf(group) >= 0;
}

function isAdmin(identity: unknown): boolean {
  return hasGroup(identity, 'admin');
}

function isModeratorOrAdmin(identity: unknown): boolean {
  return hasGroup(identity, 'admin') || hasGroup(identity, 'moderator');
}

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function auditContextFrom(event: {
  identity?: unknown;
  request?: { headers?: Record<string, string | undefined> };
}): AuditContext {
  const sub = identitySub(event.identity);
  return {
    identity: sub ? { sub } : null,
    request: { headers: event.request?.headers ?? {} },
  };
}

function snapshot(row: RecordingRow): Record<string, unknown> {
  return { ...row };
}

async function dispatchSoftDelete(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: { client: RecordingMutationsDataClient; audit: AuditFn; now: () => Date; s3: RecordingS3 },
): Promise<RecordingRow | null> {
  if (!isAdmin(event.identity)) {
    throw new Error('softDeleteRecording: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('softDeleteRecording: caller has no identity sub');
  }

  const args = event.arguments;
  const targetId = typeof args.recordingId === 'string' ? args.recordingId : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!targetId) {
    throw new Error('softDeleteRecording: recordingId argument is required');
  }

  const fetched = await deps.client.models.Recording.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`softDeleteRecording: Recording row not found for id=${targetId}`);
  }
  if (before.deletedAt) {
    return before;
  }

  const now = deps.now().toISOString();
  const normalisedReason: string | null = reason ? reason : null;

  const patch: Partial<RecordingRow> & { id: string } = {
    id: targetId,
    deletedAt: now,
    deletedBy: actorSub,
  };
  const updated = await deps.client.models.Recording.update(patch);
  if (updated.errors) {
    throw new Error(
      `softDeleteRecording: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  // S3 hard-delete (#478). Best-effort + AFTER the row update: the row is
  // the audit-of-record, so a failed object delete must not roll back the
  // soft-delete or surface as a client error. Bucket versioning turns each
  // DeleteObject into a recoverable delete-marker (30-day window). The keys
  // actually deleted are recorded on the audit `after` so the trail shows
  // exactly what was touched; a failed key is logged and omitted.
  const keys = recordingS3Keys(before);
  const s3Deleted: string[] = [];
  for (const key of keys) {
    try {
      await deps.s3.deleteObject(key);
      s3Deleted.push(key);
    } catch (err) {
      console.error('softDeleteRecording: S3 DeleteObject failed (row already soft-deleted)', {
        recordingId: targetId,
        key,
        err: String(err),
      });
    }
  }

  await deps.audit(auditContextFrom(event), {
    action: 'RECORDING_DELETE',
    targetType: 'Recording',
    targetId,
    before: snapshot(before),
    after: { ...snapshot(after), s3Deleted },
    reason: normalisedReason,
  });

  // No cascade to the parent Message: v3 archive + v4
  // recording-less submission flow (see CLAUDE.md → Domain model →
  // Recording) both rely on Messages being independent of their
  // Recording rows.

  return after;
}

/**
 * `restoreRecording` — admin-only reversal of `softDeleteRecording` (#478).
 *
 * Clears `deletedAt` / `deletedBy` on the row and restores each S3 object
 * by removing its latest delete-marker (so the prior real version is
 * exposed again) — only works inside the 30-day noncurrent-version window.
 * Idempotent on a row that is not deleted. Best-effort on the S3 side: a
 * failed restore is logged + recorded on the audit, never blocks the row
 * flip. Writes a `RECORDING_RESTORE` AuditLog entry.
 */
async function dispatchRestore(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: { client: RecordingMutationsDataClient; audit: AuditFn; now: () => Date; s3: RecordingS3 },
): Promise<RecordingRow | null> {
  if (!isAdmin(event.identity)) {
    throw new Error('restoreRecording: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('restoreRecording: caller has no identity sub');
  }
  const targetId =
    typeof event.arguments.recordingId === 'string' ? event.arguments.recordingId : '';
  const reason = typeof event.arguments.reason === 'string' ? event.arguments.reason : '';
  if (!targetId) {
    throw new Error('restoreRecording: recordingId argument is required');
  }

  const fetched = await deps.client.models.Recording.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`restoreRecording: Recording row not found for id=${targetId}`);
  }
  if (!before.deletedAt) {
    // Already live — nothing to restore.
    return before;
  }

  const patch: Partial<RecordingRow> & { id: string } = {
    id: targetId,
    deletedAt: null,
    deletedBy: null,
  };
  const updated = await deps.client.models.Recording.update(patch);
  if (updated.errors) {
    throw new Error(
      `restoreRecording: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  const keys = recordingS3Keys(before);
  const s3Restored: string[] = [];
  for (const key of keys) {
    try {
      await deps.s3.restoreObject(key);
      s3Restored.push(key);
    } catch (err) {
      console.error(
        'restoreRecording: S3 restore failed (row already un-deleted; object may be past the 30-day window)',
        { recordingId: targetId, key, err: String(err) },
      );
    }
  }

  await deps.audit(auditContextFrom(event), {
    action: 'RECORDING_RESTORE',
    targetType: 'Recording',
    targetId,
    before: snapshot(before),
    after: { ...snapshot(after), s3Restored },
    reason: reason ? reason : null,
  });

  return after;
}

/**
 * Typed error code for duplicate-hash rejection so consumers can
 * match without parsing the human message.
 */
const RECORDING_DUPLICATE_HASH = 'RECORDING_DUPLICATE_HASH';

async function dispatchSubmit(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: {
    client: RecordingMutationsDataClient;
    now: () => Date;
    enqueuePreprocess: EnqueuePreprocessFn;
  },
): Promise<RecordingRow | null> {
  const uploaderSub = identitySub(event.identity);
  if (!uploaderSub) {
    throw new Error('submitRecording: caller has no identity sub');
  }
  const args = event.arguments;
  const contentHash = typeof args.contentHash === 'string' ? args.contentHash : '';
  const originalKey = typeof args.originalKey === 'string' ? args.originalKey : '';
  if (!contentHash) {
    throw new Error('submitRecording: contentHash argument is required');
  }
  if (!originalKey) {
    throw new Error('submitRecording: originalKey argument is required');
  }

  // Server-side uniqueness check (#284). The GSI on contentHash
  // catches duplicate uploads — same audio bytes → same SHA-256 →
  // hit. Reject regardless of soft-delete state on the existing
  // row: a deleted duplicate still resolves to an existing
  // content_hash that the uniqueness invariant applies to.
  //
  // Race window: a second `submitRecording` arriving between the
  // GSI Query and the Create can clear the duplicate check and
  // land a second row with the same contentHash. Tightening via
  // DDB conditional-write + janitor sweep tracked on #297.
  // Acceptable for v1: collision requires two uploaders racing the
  // exact same audio in the sub-second window between Query and
  // Create.
  //
  // The error intentionally omits the existing row's id — clients
  // get a yes/no answer on whether the hash is taken; they don't
  // need to walk to the existing row.
  const dup = await deps.client.models.Recording.listRecordingByContentHash({ contentHash });
  if (dup.data && dup.data.length > 0) {
    throw new Error(
      `${RECORDING_DUPLICATE_HASH}: a Recording with the same contentHash already exists`,
    );
  }

  // Optional pass-through fields. `messageId` may be null when the
  // recording is uploaded ahead of a Message being attributed (the
  // transcription pipeline links them later, or v3 archive entries
  // are imported without one — per the recording-less / messageless
  // semantics introduced on #285).
  const optional: Partial<RecordingRow> = {};
  if (typeof args.messageId === 'string') optional.messageId = args.messageId;
  if (typeof args.webCanonicalKey === 'string') optional.webCanonicalKey = args.webCanonicalKey;
  if (typeof args.durationMs === 'number') optional.durationMs = args.durationMs;
  if (typeof args.frequencyKhz === 'number') optional.frequencyKhz = args.frequencyKhz;
  if (args.modulation !== undefined && args.modulation !== null) {
    if (
      args.modulation !== 'USB' &&
      args.modulation !== 'LSB' &&
      args.modulation !== 'AM' &&
      args.modulation !== 'FM'
    ) {
      // Fail fast on garbage modulation. The GraphQL enum should
      // already gate this at the AppSync layer, but the handler
      // also rejects so a directly-invoked Lambda (testing, AWS
      // console replay) can't sneak an invalid value past the
      // schema enum. Silent drop would mask a client bug.
      throw new Error(
        `submitRecording: modulation must be one of USB/LSB/AM/FM (got ${JSON.stringify(args.modulation)})`,
      );
    }
    optional.modulation = args.modulation;
  }
  if (typeof args.broadcastedAt === 'string') optional.broadcastedAt = args.broadcastedAt;
  if (typeof args.automated === 'boolean') optional.automated = args.automated;
  if (typeof args.sdrId === 'string') optional.sdrId = args.sdrId;

  const created = await deps.client.models.Recording.create({
    contentHash,
    originalKey,
    uploaderId: uploaderSub,
    transcriptionStatus: 'QUEUED',
    transcriptionFailed: false,
    migratedFromV3: false,
    ...optional,
  });
  if (created.errors) {
    throw new Error(
      `submitRecording: Recording.create returned errors: ${JSON.stringify(created.errors)}`,
    );
  }
  const row = created.data;

  // Kick off the pipeline. Fire-and-forget: a failure here must NOT
  // roll back the Recording row — the row is canonical, the queue
  // message is recoverable. Log + return so the client still sees
  // the new id; an operator (or follow-up janitor) can redrive
  // missed messages.
  if (row?.id) {
    try {
      await deps.enqueuePreprocess({
        recordingId: row.id,
        originalKey,
        contentHash,
        enqueuedAt: deps.now().toISOString(),
      });
    } catch (err) {
      console.error(
        'submitRecording: failed to enqueue preprocess message — Recording row was created but pipeline stays QUEUED until operator redrives',
        { recordingId: row.id, err: String(err) },
      );
    }
  }

  return row;
}

/**
 * `reprocessRecording` — moderator/admin re-runs the pipeline on an
 * existing recording from its stored original, with no client
 * re-upload (#505). Resets the Recording to QUEUED, clears the
 * failure fields, writes a `RECORDING_REPROCESS` audit entry, and
 * re-enqueues onto the preprocess queue (same path `submitRecording`
 * uses).
 *
 * Guards: caller must be moderator or admin; the Recording must
 * exist, not be soft-deleted, and carry an `originalKey` (a
 * recording-less Message has no audio to reprocess).
 */
async function dispatchReprocess(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: {
    client: RecordingMutationsDataClient;
    audit: AuditFn;
    now: () => Date;
    enqueuePreprocess: EnqueuePreprocessFn;
  },
): Promise<RecordingRow | null> {
  if (!isModeratorOrAdmin(event.identity)) {
    throw new Error('reprocessRecording: caller is not in the moderator or admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('reprocessRecording: caller has no identity sub');
  }

  const targetId =
    typeof event.arguments.recordingId === 'string' ? event.arguments.recordingId : '';
  const reason = typeof event.arguments.reason === 'string' ? event.arguments.reason : '';
  if (!targetId) {
    throw new Error('reprocessRecording: recordingId argument is required');
  }

  // Per-recording transcribe-backend override (#592). Validate BEFORE any
  // mutation/enqueue so a typo'd backend fails the whole call (rather than
  // silently routing to the default). An omitted arg → `whisper-local`.
  const rawBackend = event.arguments.backend;
  let backendOverride: TranscribeBackend = DEFAULT_TRANSCRIBE_BACKEND;
  if (rawBackend !== undefined && rawBackend !== null) {
    if (!isTranscribeBackend(rawBackend)) {
      throw new Error(
        `reprocessRecording: unknown transcription backend ${JSON.stringify(rawBackend)}`,
      );
    }
    backendOverride = rawBackend;
  }

  const fetched = await deps.client.models.Recording.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`reprocessRecording: Recording row not found for id=${targetId}`);
  }
  if (before.deletedAt) {
    throw new Error(
      `reprocessRecording: Recording ${targetId} is deleted and cannot be reprocessed`,
    );
  }
  const originalKey = typeof before.originalKey === 'string' ? before.originalKey : '';
  if (!originalKey) {
    throw new Error(
      `reprocessRecording: Recording ${targetId} has no stored audio (originalKey) — recording-less entries cannot be reprocessed`,
    );
  }

  // Intentionally NOT blocked on in-flight states. Reprocess is the
  // recovery tool for STUCK recordings, which usually sit in a
  // non-terminal state (hung Whisper, lost SQS message); refusing those
  // would defeat the feature. Re-enqueue regardless, but log when we
  // override a non-terminal state so a genuinely-concurrent live run
  // (rare) is visible. Duplicate-Message risk from a truly concurrent
  // run is tracked separately on #454 (linguistic redrive dedup).
  const priorStatus = before.transcriptionStatus ?? 'UNKNOWN';
  const NON_TERMINAL = ['QUEUED', 'PREPROCESSING', 'TRANSCRIBING', 'PARSING'];
  if (NON_TERMINAL.indexOf(priorStatus) >= 0) {
    console.warn('reprocessRecording: reprocessing a recording in a non-terminal state', {
      recordingId: targetId,
      priorStatus,
    });
  }

  const ts = deps.now().toISOString();
  const patch: Partial<RecordingRow> & { id: string } = {
    id: targetId,
    transcriptionStatus: 'QUEUED',
    transcriptionFailed: false,
    failedReason: null,
    transcriptionStatusUpdatedAt: ts,
  };
  const updated = await deps.client.models.Recording.update(patch);
  if (updated.errors) {
    throw new Error(
      `reprocessRecording: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  // Re-enqueue from the stored original FIRST — the functional reprocess
  // (reset + pipeline kick-off) must complete even if the audit write
  // hiccups. Same queue + payload shape submitRecording publishes, so
  // the full pipeline re-runs with no client re-upload. A failed enqueue
  // leaves the row QUEUED for an operator redrive rather than rolling
  // back the reset.
  try {
    await deps.enqueuePreprocess({
      recordingId: targetId,
      originalKey,
      contentHash: typeof before.contentHash === 'string' ? before.contentHash : '',
      enqueuedAt: ts,
      backendOverride,
    });
  } catch (err) {
    console.error(
      'reprocessRecording: failed to enqueue preprocess message — Recording reset to QUEUED but pipeline stays idle until operator redrives',
      { recordingId: targetId, err: String(err) },
    );
  }

  // Audit best-effort — a failed audit must not strand a recording
  // reset-but-not-reprocessed or surface as a client error. The chosen
  // backend is recorded on `after` so the audit trail shows which backend
  // the admin re-ran on (#592).
  try {
    await deps.audit(auditContextFrom(event), {
      action: 'RECORDING_REPROCESS',
      targetType: 'Recording',
      targetId,
      before: snapshot(before),
      after: { ...snapshot(after), backendOverride },
      reason: reason ? reason : null,
    });
  } catch (err) {
    console.error('reprocessRecording: audit write failed (reprocess still ran)', {
      recordingId: targetId,
      err: String(err),
    });
  }

  return after;
}

/**
 * `reparseRecording` — moderator/admin re-runs ONLY the linguistic
 * (AI parse) stage on a recording's stored transcript, skipping
 * preprocess + transcribe (#566). Use case: re-parse after a model /
 * prompt change without paying to re-transcribe the audio.
 *
 * Enqueues the stored `transcript` straight onto the linguistic SQS
 * queue as the same `TranscriptQueueMessage` the Whisper container
 * publishes, so the existing classifier + dedup + supersede path
 * (#454/#556) runs unchanged. Writes a `RECORDING_REPARSE` AuditLog
 * entry — distinct from the full `RECORDING_REPROCESS` (#505) so the
 * audit trail separates a parse-only re-run from a re-transcribe (the
 * linguistic re-run is the auditable action; the row itself is not
 * mutated here).
 *
 * Guards: caller must be moderator or admin; the Recording must exist,
 * not be soft-deleted, and carry a non-empty `transcript` (a recording
 * that never transcribed has nothing to re-parse).
 */
async function dispatchReparse(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: {
    client: RecordingMutationsDataClient;
    audit: AuditFn;
    now: () => Date;
    enqueueLinguistic: EnqueueLinguisticFn;
  },
): Promise<RecordingRow | null> {
  if (!isModeratorOrAdmin(event.identity)) {
    throw new Error('reparseRecording: caller is not in the moderator or admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('reparseRecording: caller has no identity sub');
  }

  const targetId =
    typeof event.arguments.recordingId === 'string' ? event.arguments.recordingId : '';
  const reason = typeof event.arguments.reason === 'string' ? event.arguments.reason : '';
  if (!targetId) {
    throw new Error('reparseRecording: recordingId argument is required');
  }

  const fetched = await deps.client.models.Recording.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`reparseRecording: Recording row not found for id=${targetId}`);
  }
  if (before.deletedAt) {
    throw new Error(`reparseRecording: Recording ${targetId} is deleted and cannot be re-parsed`);
  }
  const transcript = typeof before.transcript === 'string' ? before.transcript : '';
  if (!transcript) {
    throw new Error(
      `reparseRecording: Recording ${targetId} has no stored transcript — re-transcribe (reprocessRecording) first`,
    );
  }

  const ts = deps.now().toISOString();

  // Enqueue onto the linguistic queue FIRST — the functional re-parse
  // must complete even if the audit write hiccups. Same payload shape the
  // Whisper container publishes, so the linguistic Lambda's
  // processTranscript runs unchanged (#454 dedup + #556 supersede).
  await deps.enqueueLinguistic({
    kind: 'transcript',
    recordingId: targetId,
    transcript,
    enqueuedAt: ts,
  });

  // Audit best-effort — a failed audit must not strand a re-parse already
  // on the queue or surface as a client error. The row is not mutated, so
  // before == after; the AuditLog records the action + actor.
  try {
    await deps.audit(auditContextFrom(event), {
      action: 'RECORDING_REPARSE',
      targetType: 'Recording',
      targetId,
      before: snapshot(before),
      after: snapshot(before),
      reason: reason ? reason : 'Re-parse transcript (linguistic stage only) (#566)',
    });
  } catch (err) {
    console.error('reparseRecording: audit write failed (re-parse still enqueued)', {
      recordingId: targetId,
      err: String(err),
    });
  }

  return before;
}

// `_context` / `_callback` are declared explicitly (vs. the
// shorter `async (event) => …` form) so the test fixtures that
// pass all three Lambda-runtime arguments don't trip CodeQL's
// "Superfluous trailing arguments" rule. The body still ignores
// them.
export const handler: AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null> = async (
  event,
  _context,
  _callback,
) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());
  const enqueuePreprocess: EnqueuePreprocessFn =
    injected.enqueuePreprocess ?? defaultEnqueuePreprocess;
  const enqueueLinguistic: EnqueueLinguisticFn =
    injected.enqueueLinguistic ?? defaultEnqueueLinguistic;
  const s3: RecordingS3 = injected.s3 ?? defaultS3;
  const deps = { client, audit: auditFn, now, s3 };

  // AppSync's pipeline-function payload puts `fieldName` at the top level
  // (see the VTL template generated by Amplify Gen 2 for Lambda data sources).
  // The `AppSyncResolverHandler` type "shapes" it under `info.fieldName` though,
  // and unit-test fixtures mirrored that shape. Accept both so real prod
  // invocations + existing tests keep working.
  const field = (event as unknown as { fieldName?: string }).fieldName ?? event.info?.fieldName;
  switch (field) {
    case 'softDeleteRecording':
      return dispatchSoftDelete(event, deps);
    case 'submitRecording':
      return dispatchSubmit(event, { client, now, enqueuePreprocess });
    case 'reprocessRecording':
      return dispatchReprocess(event, { client, audit: auditFn, now, enqueuePreprocess });
    case 'reparseRecording':
      return dispatchReparse(event, { client, audit: auditFn, now, enqueueLinguistic });
    case 'restoreRecording':
      return dispatchRestore(event, deps);
    default:
      throw new Error(`recordingMutations: unsupported fieldName "${field}"`);
  }
};
