import { a } from '@aws-amplify/backend';
import { messageMutations } from '../../functions/messageMutations/resource';

/**
 * Message — a single EAM broadcast event (issue #28).
 *
 * One Message → 0..N Recordings — the v3 archive carries Messages with no
 * audio, and the v4 recording-less submission flow (#285) creates Messages
 * directly from a witness account gated by reputation + rate-limit (see
 * `submitRecordingLessMessage` below). The parsed fields (`sender`,
 * `receiver`, `body`, etc.) are derived from the recordings' transcripts via
 * the Linguistic Logic Lambda for the SDR-driven path, or carried straight
 * from the witness submission on the recording-less path. Edits append
 * revisions rather than overwriting (audit + community vote — phase 2 #34).
 *
 * Soft-delete only — `deletedAt` / `deletedBy` / `deletedReason` are set by
 * the admin-only `softDeleteMessage` custom mutation defined below. Default
 * list queries should filter `deletedAt = null` (custom resolver / subscription
 * middleware tracked as a follow-up — Amplify Gen 2 model-level filters can't
 * express the predicate on their own).
 */
export const Message = a
  .model({
    broadcastTs: a.datetime().required(),
    sender: a.string(),
    receiver: a.string(),
    type: a.enum([
      'BACKEND',
      'SKYKING',
      'ALLSTATIONS',
      'RADIOCHECK',
      'SKYMASTER',
      'SKYBIRD',
      'DISREGARDED',
      'OTHER',
    ]),
    body: a.string(),
    characterCount: a.integer(),
    codewordCount: a.integer(),
    // Linguistic Logic output: 0.0 – 1.0. Default threshold 0.8 — below that
    // the Message auto-publishes flagged for community review.
    confidence: a.float(),
    flaggedForReview: a.boolean().default(false),
    publishedAt: a.datetime(),
    // Recording-less submission provenance (#285). Both fields are null
    // for SDR-derived Messages — only the witness flow populates them.
    // `submitterId` is the Cognito sub of the submitting user; `submittedAt`
    // is the server-stamped UTC ingest time and feeds the per-user
    // rate-limit query via the GSI below.
    submitterId: a.id(),
    submittedAt: a.datetime(),
    // Distinguishes backfilled rows from organic submissions (phase 7).
    migratedFromV3: a.boolean().default(false),
    legacyUuid: a.string(),
    // Soft-delete sentinels — populated by the admin-only mutation.
    deletedAt: a.datetime(),
    deletedBy: a.id(),
    deletedReason: a.string(),
    recordings: a.hasMany('Recording', 'messageId'),
    comments: a.hasMany('Comment', 'messageId'),
    fieldVotes: a.hasMany('FieldVote', 'messageId'),
    auditEntries: a.hasMany('AuditLog', 'targetMessageId'),
  })
  .secondaryIndexes((i) => [
    // Default browse view: messages of a given type ordered by broadcast time.
    i('type').sortKeys(['broadcastTs']),
    // Legacy claim path: look up a backfilled Message by its v3 UUID.
    i('legacyUuid'),
    // Recording-less submission rate-limit (#285): sortable by
    // submittedAt so the per-user rate-limit Query can pass a
    // `submittedAt: { ge: windowStart }` predicate against the GSI's
    // range key. The time-window enforcement lives in the handler,
    // not the index — the index just makes the Query efficient.
    i('submitterId').sortKeys(['submittedAt']),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read', 'create']),
    allow.groups(['moderator', 'admin']).to(['read', 'create', 'update', 'delete']),
  ]);

/**
 * `softDeleteMessage` — admin-only Message soft-delete (#28).
 *
 * Sets `deletedAt = now`, `deletedBy = caller.sub`, `deletedReason =
 * reason`. Emits a `MESSAGE_DELETE` AuditLog entry via the #258
 * helper. Idempotent — re-calling on an already-deleted row returns
 * it untouched.
 *
 * Lambda-backed (see `functions/messageMutations`) so the audit
 * helper (TypeScript, writes to a separate data source) is the sole
 * AuditLog writer. JS pipelines can't import the shared TS helper.
 *
 * Schema-level grant for the Lambda's IAM role lives in
 * `data/resource.ts` under `.authorization((allow) => [...])`.
 */
export const softDeleteMessage = a
  .mutation()
  .arguments({
    messageId: a.id().required(),
    reason: a.string(),
  })
  .returns(a.ref('Message'))
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(messageMutations));

/**
 * `submitRecordingLessMessage` — witness-account submission (#285).
 *
 * Lets an authenticated user create a Message directly without an
 * accompanying Recording (use case: they heard a broadcast but did
 * not capture audio). To bound abuse the handler enforces:
 *
 *   1. **Ban check** — banned users rejected outright.
 *   2. **Per-day rate-limit** — counts the caller's own
 *      `submitRecordingLessMessage`-created Messages in the trailing
 *      24h via the `submitterId` GSI. Default cap 5 / member, 20 /
 *      moderator, unlimited / admin (configurable via
 *      `RECORDINGLESS_RATE_LIMIT_MEMBER` / `RECORDINGLESS_RATE_LIMIT_MOD`
 *      env vars).
 *   3. **Reputation gate for publish-vs-queue** — caller's
 *      Reputation.computedWeight must meet a configurable threshold
 *      (default 1.5; `RECORDINGLESS_REP_THRESHOLD` env var) to land
 *      with `publishedAt = now`. Below threshold the Message lands
 *      with `publishedAt = null` (mod queue). Moderators + admins
 *      always publish-now.
 *
 * Every submission lands with `flaggedForReview = true` regardless
 * of the gate outcome — recording-less Messages should never sit
 * alongside SDR-derived entries unchallenged. Every submission also
 * writes a `MESSAGE_SUBMIT_RECORDINGLESS` AuditLog entry that captures
 * the verification provenance (reputation, role, rate-limit window
 * count, queued vs published outcome).
 *
 * Lambda-backed via `messageMutations`. No CAPTCHA dependency at
 * v1 — the gate is reputation + rate-limit only. A pluggable
 * verification provider hook (Turnstile / hCaptcha) can layer in
 * later behind a feature flag; that integration is the owner's call
 * during pickup since it requires a third-party site key.
 */
export const submitRecordingLessMessage = a
  .mutation()
  .arguments({
    broadcastTs: a.datetime().required(),
    sender: a.string(),
    receiver: a.string(),
    // String over `a.ref('MessageType')` because the type enum is
    // defined inline on the Message model and not exported as a
    // top-level enum. Handler validates the value against the same
    // list that lives on the model.
    type: a.string(),
    body: a.string(),
  })
  .returns(a.ref('Message'))
  .authorization((allow) => allow.authenticated())
  .handler(a.handler.function(messageMutations));
