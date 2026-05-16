import { a } from '@aws-amplify/backend';

/**
 * AuditLog — immutable record of every admin / mod / system action (#38).
 *
 * Retained forever per CLAUDE.md. Authz grants admins `create` only (no
 * `update`, no `delete`) so the API surface enforces append-only semantics —
 * client cannot mutate prior entries. Read access is intentionally public
 * (guest + authenticated): the audit log is a transparency surface so users
 * can see what mods did to their stuff.
 *
 * `targetType` + `targetId` are polymorphic — string for cross-table
 * compatibility. `targetMessageId` is a typed optional FK so AppSync can
 * resolve `Message.auditEntries` cheaply for the common message-history
 * lookup; other entity types stick to the polymorphic columns.
 *
 * Deferred:
 *   - Public-read filter resolver that hides entries irrelevant to the
 *     viewer (e.g. user bans they were not part of).
 *   - Server-side hook from every admin mutation that auto-emits an entry.
 *     For now, the production code paths must call the create explicitly.
 */
export const AuditLog = a
  .model({
    // Cognito sub of the actor, or `null` for system-emitted entries
    // (auto-publish on confidence ≥ 0.8, pipeline status transitions,
    // scheduled jobs). Consumers must treat null as "system" and surface
    // accordingly.
    actorId: a.id(),
    action: a.enum([
      'MESSAGE_DELETE',
      'MESSAGE_RESTORE',
      'MESSAGE_EDIT',
      'RECORDING_DELETE',
      'RECORDING_RESTORE',
      'COMMENT_DELETE',
      'USER_BAN',
      'USER_UNBAN',
      'USER_ROLE_CHANGE',
      'USER_PII_BLANK',
      // Legacy v3 → Cognito claim: PK rewrite from `legacy:<id>` to
      // the real sub via TransactWriteItems Put+Delete. Emitted by
      // `linkLegacyClaim` (sub-A of #16 → #272). Subsequent FK
      // fan-out (#273) emits `USER_CLAIM_FANOUT`; the cron sweep
      // for partial-state replay (#274) reuses these via `claimId`.
      'USER_CLAIM',
      // Per-table FK rewrite emitted by `fanOutLegacyFks` after the
      // User row is claimed (sub-B of #16 → #273). One entry per
      // (table, batch); the `claimId` field correlates entries belonging
      // to the same claim. PR C (#274) reads this manifest on partial-
      // state replay to know which tables have already fanned out.
      'USER_CLAIM_FANOUT',
      // Scheduled cleanup of FieldVote rows whose `messageId` no
      // longer resolves to a Message (#270). Emitted once per sweep
      // with the orphan count + sample messageIds in `after`.
      'FIELDVOTE_ORPHAN_SWEEP',
      'TRANSMITTER_CREATE',
      'TRANSMITTER_UPDATE',
      'TRANSMITTER_DELETE',
      'CALLSIGN_MERGE',
      'LINGUISTIC_CONFIG_UPDATE',
      'BAN_REGION_PAGE_UPDATE',
      'PROMPT_VERSION_BUMP',
      'BUDGET_THRESHOLD_UPDATE',
      'REP_FORMULA_UPDATE',
      'OTHER',
    ]),
    targetType: a.string(),
    targetId: a.string(),
    // Optional typed FK for fast Message → audit entries lookup.
    targetMessageId: a.id(),
    targetMessage: a.belongsTo('Message', 'targetMessageId'),
    diff: a.json(),
    reason: a.string(),
    ipAddress: a.string(),
    userAgent: a.string(),
    // Cross-entry correlation key (#274). Used by the legacy-claim
    // sub-flows so the User-row claim (#272 USER_CLAIM) + every
    // per-table fan-out batch (#273 USER_CLAIM_FANOUT) share a
    // manifest key. The replay sweeper (#274) groups by this column
    // to know what work has already been done for a given claim.
    // Other audit actions leave it null.
    claimId: a.string(),
  })
  .secondaryIndexes((i) => [
    // "What did actor X do" — sparse index, only populated for actor-emitted
    // entries (skips system entries where actorId is null). Sort client-side
    // by `createdAt` (Amplify Gen 2 does not allow the implicit `createdAt`
    // as an index sort key).
    i('actorId'),
    // "What happened to this entity" — sort on targetId so the
    // legacy-claim replay sweeper (#274) can read every entry for
    // a single (targetType=User, targetId=<sub>) pair without a
    // table scan.
    i('targetType').sortKeys(['targetId']),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read']),
    // Admins create only — never update or delete. Append-only forever.
    allow.groups(['admin']).to(['create']),
  ]);
