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
    actorId: a.id().required(),
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
  })
  .secondaryIndexes((i) => [
    // "What did actor X do" — sort client-side by `createdAt` (Amplify Gen 2
    // does not allow the implicit `createdAt` as an index sort key).
    i('actorId'),
    // "What happened to this entity" — same client-side sort.
    i('targetType'),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read']),
    // Admins create only — never update or delete. Append-only forever.
    allow.groups(['admin']).to(['create']),
  ]);
