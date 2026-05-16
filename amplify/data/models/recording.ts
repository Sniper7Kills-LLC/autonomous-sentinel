import { a } from '@aws-amplify/backend';

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
    transcript: a.string(),
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
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read', 'create']),
    allow.groups(['moderator', 'admin']).to(['read', 'create', 'update', 'delete']),
  ]);
