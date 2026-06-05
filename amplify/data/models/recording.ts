import { a } from '@aws-amplify/backend';
import { recordingMutations } from '../../functions/recordingMutations/resource';

/**
 * Recording — a single audio capture of a broadcast (issue #29).
 *
 * Content-hashed (deduped on upload — second submission with the same hash is
 * rejected by the `submitRecording` mutation, deferred). Two persistent S3
 * keys: `originalKey` is exactly what the uploader sent; `webCanonicalKey` is
 * the Opus 32 kbps mono derivative the pre-process Lambda emits for browser
 * playback. Three sidecar S3 keys hold derived artifacts: `wordTimestampsKey`
 * (alignment JSON for scrub-to-text), `peaksJsonKey` (downsampled waveform for
 * fast render), plus the canonical itself.
 *
 * `linguisticAttempts` is an append-only JSON log of
 * `{provider, promptVersion, promptHash, resultHash, timestamp}` entries —
 * the Linguistic Logic Lambda writes this so that the same provider +
 * prompt version never re-runs against the same input, and a prompt version
 * bump re-processes only previously-failed rows (per CLAUDE.md architecture).
 *
 * Deferred to follow-ups:
 *   - `submitRecording` custom mutation (content_hash uniqueness + duplicate
 *     rejection with `RECORDING_DUPLICATE_HASH` error)
 *   - Soft-delete cascade: deleting the last Recording on a Message soft-
 *     deletes the Message too (custom mutation; depends on AuditLog #38)
 *   - S3 hard-delete of `originalKey` / `webCanonicalKey` / sidecars on
 *     Recording delete (phase 3 / storage lifecycle work)
 *   - `revisions` hasMany TranscriptRevision (model lands in #34)
 */
export const Recording = a
  .model({
    messageId: a.id(),
    message: a.belongsTo('Message', 'messageId'),
    // Uploader FK to User (#248). Stores the Cognito sub directly — see
    // #259 for the `User.id = cognitoSub` decision. Populated by the upload
    // client (phase 6) from `ctx.identity.sub` at upload time.
    uploaderId: a.id(),
    uploader: a.belongsTo('User', 'uploaderId'),
    // SDR FK (issue #30 ↔ #29 cross-reference).
    sdrId: a.id(),
    sdr: a.belongsTo('Sdr', 'sdrId'),

    // SHA-256 of original bytes; unique per recording.
    contentHash: a.string().required(),
    // S3 keys.
    originalKey: a.string().required(),
    webCanonicalKey: a.string(),
    wordTimestampsKey: a.string(),
    peaksJsonKey: a.string(),
    canonicalSizeBytes: a.integer(),

    // Duration as captured + as detected by VAD (phase 3 #50).
    durationMs: a.integer(),
    speechDurationMs: a.integer(),

    frequencyKhz: a.integer(),
    modulation: a.enum(['USB', 'LSB', 'AM', 'FM']),
    broadcastedAt: a.datetime(),
    automated: a.boolean().default(false),

    // Pipeline status. The `*_FAILED` intermediate states tell the admin
    // DLQ + manual reprocess UI (#107) which stage broke.
    transcriptionStatus: a.enum([
      'QUEUED',
      'PREPROCESSING',
      'PREPROCESS_FAILED',
      'TRANSCRIBING',
      'TRANSCRIBE_FAILED',
      'PARSING',
      'PARSE_FAILED',
      'PUBLISHED',
      'FAILED',
    ]),
    transcriptionFailed: a.boolean().default(false),
    // Last-mutation timestamp on `transcriptionStatus` — drives the
    // AppSync `onUpdateRecording` subscription (#70) so the My Uploads
    // page can sort by "most recent activity" without a separate GSI
    // scan. Each pipeline stage sets it alongside the status via Amplify
    // Data (`client.models.Recording.update`) so the subscription fires:
    // preprocess → PREPROCESSING/TRANSCRIBING, linguistic →
    // PARSING/PUBLISHED, failure paths → *_FAILED.
    transcriptionStatusUpdatedAt: a.datetime(),
    // Human-readable failure reason captured on FAILED transitions
    // (#69). The granular `*_FAILED` enum values on
    // `transcriptionStatus` carry the stage; this column carries the
    // why (e.g. "AppSync timeout", "Bedrock rate-limited"). Admin DLQ
    // reprocess UI (#107) reads this to triage.
    failedReason: a.string(),
    transcript: a.string(),
    // Overall whisper transcription confidence (#581): mean per-token
    // probability `p` over content tokens, in [0,1]. Written by the
    // linguistic Lambda from the value the Whisper container carries on
    // the transcript queue message. Null when the transcriber emitted no
    // per-token probabilities. Distinct from `Message.confidence`, which
    // is the linguistic-PARSE confidence. Feeds the low-confidence Amazon
    // Transcribe escalation gate (#582) + the moderator debug panel (#561).
    transcriptionConfidence: a.float(),
    // Per-backend transcript collection (#593). A JSON array of
    // `{ backend, transcript, transcriptionConfidence, wordTimestampsKey?, ts }`
    // entries — one per transcription backend that has run on this
    // Recording (whisper-local, amazon-transcribe, …). A Recording is
    // now allowed MULTIPLE independent ASR passes side by side so the
    // Bedrock parse can reconcile across them (whisper "Oxtra" vs
    // Transcribe "Foxtrot").
    //
    // Model choice (#593, owner-confirmable): a `transcripts` JSON ARRAY
    // on the Recording rather than a new `Transcript` child model. The
    // collection is tiny (a handful of backends, never paginated), is
    // read-and-rewritten wholesale by the linguistic Lambda on every
    // transcript arrival, and has no independent authz/query surface —
    // so a child model would add a table + GSI + resolver round-trips
    // for no benefit. The linguistic handler UPSERTS by `backend` (never
    // replaces the other backends' entries).
    //
    // Back-compat: the top-level `transcript` / `transcriptionConfidence`
    // above remain the "primary/active" transcript every existing reader
    // (web detail panel, reparse, REST) already consumes. The linguistic
    // handler keeps them in sync with the best entry in `transcripts`
    // (primary = highest `transcriptionConfidence`; ties / missing
    // confidence break to the most-recently-arrived entry) so a
    // single-whisper recording behaves exactly as before — `transcripts`
    // simply holds one entry.
    transcripts: a.json(),
    // Low-confidence escalation marker (#588 / epic #582). Set by the
    // linguistic Lambda the first (and only) time it auto-escalates a
    // low-confidence whisper transcript to the Amazon Transcribe backend
    // for a second independent ASR pass. Its presence is the loop guard:
    // an escalated recording is never escalated again (never bounce
    // whisper↔transcribe). Distinct from a re-transcribe — escalation is
    // automatic + fire-and-forget; the reconciled re-parse updates the
    // same Message later (#556 supersede).
    escalatedAt: a.datetime(),
    // Append-only log of linguistic attempts. Written by #64.
    linguisticAttempts: a.json(),

    // Phase 7 backfill marker.
    migratedFromV3: a.boolean().default(false),

    // Soft-delete sentinels. `deletedBy` stores the Cognito sub of the
    // admin who issued the delete — same sub-as-id pattern as
    // `AuditLog.actorId` (per #259 Option A + the decision recorded on
    // #260). No `belongsTo('User', ...)` because Amplify Gen 2 requires a
    // reciprocal `hasMany` for every `belongsTo`, and admin reads of the
    // actor row are denormalised (separate query when needed) rather than
    // walked through the graph.
    deletedAt: a.datetime(),
    deletedBy: a.id(),

    revisions: a.hasMany('TranscriptRevision', 'recordingId'),
  })
  .secondaryIndexes((i) => [
    // Dedup lookup at upload time.
    i('contentHash'),
    // Browse by SDR + time window.
    i('sdrId').sortKeys(['broadcastedAt']),
    // Pipeline DLQ + admin reprocess queries.
    i('transcriptionStatus'),
    // Required for the legacy-claim FK fan-out (#273) — Query by uploaderId
    // to find every Recording a freshly-claimed user uploaded.
    i('uploaderId'),
    // Required for the soft-delete cascade (#29) — after soft-deleting
    // a Recording, the handler Queries siblings by messageId to decide
    // whether the parent Message should cascade-soft-delete.
    i('messageId'),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    // `create` is intentionally dropped from authenticated AND from
    // the mod/admin group authz: the `submitRecording` custom mutation
    // (#284) is the sole client-callable create path so the server
    // can enforce contentHash uniqueness + set `uploaderId` from
    // `ctx.identity.sub` instead of trusting the client. Mods and
    // admins go through `submitRecording` too — otherwise the auto-
    // generated `createRecording` mutation would let a mod account
    // bypass uniqueness enforcement.
    allow.authenticated().to(['read']),
    // #430 Cognito-group sweep — only `member` here; admin + moderator
    // already covered by the elevated rule below (Amplify @auth
    // rejects the same group in two `allow.groups(...)` rules per
    // model).
    allow.groups(['member']).to(['read']),
    allow.groups(['moderator', 'admin']).to(['read', 'update', 'delete']),
  ]);

/**
 * `softDeleteRecording` — admin-only Recording soft-delete (#29).
 *
 * Sets `deletedAt = now`, `deletedBy = caller.sub` on the row.
 * Emits a `RECORDING_DELETE` AuditLog entry via the #258 helper
 * (reason captured on the audit only — Recording has no
 * `deletedReason` column). Idempotent on already-deleted rows.
 *
 * Lambda-backed (see `functions/recordingMutations`) so the audit
 * helper is the sole AuditLog writer.
 *
 * No cascade to the parent Message on Recording delete. The v3
 * archive contains Messages with no Recording for analytics, and
 * the v4 submission flow supports recording-less entries gated by a
 * verification step (anti-spam — tracked separately). A Recording
 * delete therefore touches only the Recording row; the parent
 * Message keeps standing.
 *
 * S3 hard-delete (#478): after the row update the handler issues
 * DeleteObject on the recording's `originalKey` / `webCanonicalKey` /
 * `wordTimestampsKey` / `peaksJsonKey`. Bucket versioning turns each into
 * a recoverable delete-marker (30-day noncurrent-version window per
 * `storage-lifecycle.ts`); `restoreRecording` reverses it inside that
 * window. Best-effort — a failed object delete is logged + recorded on
 * the audit `after.s3Deleted`, never rolls back the row soft-delete.
 */
export const softDeleteRecording = a
  .mutation()
  .arguments({
    recordingId: a.id().required(),
    reason: a.string(),
  })
  .returns(a.ref('Recording'))
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(recordingMutations));

/**
 * `submitRecording` — authenticated Recording upload mutation (#284).
 *
 * Sole client-callable create path on Recording. The Lambda handler:
 *   1. Rejects callers with no identity sub.
 *   2. Queries the `recording-contentHash-index` GSI for any row
 *      with the same `contentHash`; if found (deleted or not),
 *      throws `RECORDING_DUPLICATE_HASH` so the upload client can
 *      surface the conflict to the user.
 *   3. Creates the row with `uploaderId = ctx.identity.sub` (never
 *      trusted from the client), `transcriptionStatus = QUEUED`, and
 *      the optional pass-through fields (messageId, frequencyKhz,
 *      modulation, broadcastedAt, automated, sdrId).
 *
 * `messageId` is intentionally optional: the v3 archive has
 * Messages with no Recording AND the v4 submission flow allows
 * recording-less entries (gated separately by an anti-spam
 * verification step — tracked on a follow-up issue). A Recording
 * uploaded ahead of attribution carries `messageId = null` until the
 * transcription pipeline (or an admin) links it.
 *
 * No audit entry on create — only mutating-once-published events
 * (RECORDING_DELETE, MESSAGE_EDIT) write to AuditLog. The Recording
 * row's own existence is its source of truth.
 */
export const submitRecording = a
  .mutation()
  .arguments({
    contentHash: a.string().required(),
    originalKey: a.string().required(),
    messageId: a.id(),
    webCanonicalKey: a.string(),
    durationMs: a.integer(),
    frequencyKhz: a.integer(),
    modulation: a.enum(['USB', 'LSB', 'AM', 'FM']),
    broadcastedAt: a.datetime(),
    automated: a.boolean(),
    sdrId: a.id(),
  })
  .returns(a.ref('Recording'))
  // Default auth mode is `identityPool`. `allow.authenticated()` only
  // grants the generic `amplifyAuthauthenticatedRole`; users in a
  // Cognito group route to per-group IAM roles (`...adminGroupRole`
  // etc.) which inherit nothing. Enumerate every group explicitly so
  // the mutation works for any signed-in caller regardless of which
  // role Identity Pool hands them. See the parallel storage fix in
  // PR #427.
  .authorization((allow) => [allow.authenticated(), allow.groups(['admin', 'moderator', 'member'])])
  .handler(a.handler.function(recordingMutations));

/**
 * `reprocessRecording` — moderator/admin re-runs the pipeline on an
 * existing recording from its stored original, with no client
 * re-upload (#505). Resets the row to QUEUED, clears the failure
 * fields, writes a `RECORDING_REPROCESS` AuditLog entry, and
 * re-enqueues onto the preprocess queue. Guards (in the handler):
 * recording must exist, not be soft-deleted, and have an
 * `originalKey` — recording-less Messages have no audio to reprocess.
 *
 * Optional `backend` (#592) — which transcription backend re-processes
 * the recording (CLAUDE.md: "admin can re-run a single recording on a
 * different backend for comparison"). Validated against
 * `TRANSCRIBE_BACKENDS` in the handler; an unknown value is rejected and
 * an omitted value defaults to `whisper-local`. The chosen backend is
 * threaded onto the preprocess message as `backendOverride`, forwarded
 * by the preprocess Lambda onto the transcribe-queue message so the
 * dispatcher (#587/#589) routes it. Recorded on the AuditLog `after`.
 */
export const reprocessRecording = a
  .mutation()
  .arguments({
    recordingId: a.id().required(),
    reason: a.string(),
    backend: a.string(),
  })
  .returns(a.ref('Recording'))
  // Moderator + admin only. Enumerated per-group for Identity Pool
  // role routing (same rationale as submitRecording above).
  .authorization((allow) => allow.groups(['admin', 'moderator']))
  .handler(a.handler.function(recordingMutations));

/**
 * `reparseRecording` — moderator/admin re-runs ONLY the linguistic
 * (AI parse) stage on a recording's stored transcript, skipping
 * preprocess + transcribe (#566). The handler enqueues the stored
 * `transcript` straight onto the linguistic SQS queue as the same
 * message shape the Whisper container publishes, then writes a
 * `RECORDING_REPROCESS` AuditLog entry. Guards (in the handler):
 * recording must exist, not be soft-deleted, and carry a non-empty
 * `transcript` — a recording that never transcribed has nothing to
 * re-parse. Use case: re-parse after a model/prompt change without
 * paying to re-transcribe.
 */
export const reparseRecording = a
  .mutation()
  .arguments({
    recordingId: a.id().required(),
    reason: a.string(),
  })
  .returns(a.ref('Recording'))
  // Moderator + admin only. Enumerated per-group for Identity Pool
  // role routing (same rationale as reprocessRecording above).
  .authorization((allow) => allow.groups(['admin', 'moderator']))
  .handler(a.handler.function(recordingMutations));

/**
 * `restoreRecording` — admin-only reversal of `softDeleteRecording` (#478).
 *
 * Clears `deletedAt` / `deletedBy` on the row and restores each S3 object
 * by removing its latest delete-marker (exposing the prior real version) —
 * only effective inside the 30-day noncurrent-version recovery window.
 * Idempotent on a non-deleted row. Best-effort on S3: a failed restore is
 * logged + recorded on the audit `after.s3Restored`, never blocks the row
 * un-delete. Writes a `RECORDING_RESTORE` AuditLog entry.
 */
export const restoreRecording = a
  .mutation()
  .arguments({
    recordingId: a.id().required(),
    reason: a.string(),
  })
  .returns(a.ref('Recording'))
  // Admin only — restore is a recovery action, narrower than the
  // moderator-accessible reprocess/reparse.
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(recordingMutations));
