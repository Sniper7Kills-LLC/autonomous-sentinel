import { a } from '@aws-amplify/backend';

/**
 * AbuseReport — user-flagged spam / bad entries routed to the mod queue (#37).
 *
 * `targetType` + `targetId` are polymorphic (Message / Recording / Comment /
 * User) — string-typed because there is no DDB-side FK constraint anyway, and
 * sticking to ID would lock us to one target table.
 *
 * Reporters create-only; they cannot edit or delete their own reports after
 * submission (prevents griefing). Reporters can `read` their own (owner authz)
 * so they can see status updates. Mods + admins read the whole queue and
 * update status / modAction.
 */
export const AbuseReport = a
  .model({
    reporterId: a.id().required(),
    reporter: a.belongsTo('User', 'reporterId'),
    targetType: a.enum(['MESSAGE', 'RECORDING', 'COMMENT', 'USER']),
    targetId: a.id().required(),
    reason: a.enum([
      'SPAM',
      'OFFENSIVE',
      'WRONG_INFO',
      'IMPERSONATION',
      'OTHER',
    ]),
    notes: a.string(),
    status: a.enum(['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED']),
    resolvedById: a.id(),
    resolvedAt: a.datetime(),
    modAction: a.string(),
  })
  .secondaryIndexes((i) => [
    // Mod queue: list reports by status (sort client-side by createdAt — the
    // implicit `createdAt` field is not addressable as an index sort key in
    // Amplify Gen 2).
    i('status'),
    // "All reports against this entity" — polymorphic target lookup.
    i('targetType').sortKeys(['targetId']),
  ])
  .authorization((allow) => [
    allow.authenticated().to(['create']),
    allow.owner().to(['read']),
    allow.groups(['moderator', 'admin']).to(['read', 'update']),
  ]);
