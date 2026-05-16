import { a } from '@aws-amplify/backend';
import { messageMutations } from '../../functions/messageMutations/resource';

/**
 * Message — a single EAM broadcast event (issue #28).
 *
 * One Message → many Recordings (multiple SDRs catch the same broadcast). The
 * parsed fields (`sender`, `receiver`, `body`, etc.) are derived from the
 * recordings' transcripts via the Linguistic Logic Lambda. Edits append
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
