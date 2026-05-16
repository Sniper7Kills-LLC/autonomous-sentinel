import { a } from '@aws-amplify/backend';

/**
 * NotificationPreference — per-user channel toggles + per-message-type
 * subscription map (#41).
 *
 * 1:1 with User via `userId` identifier. `subscribedTypes` is the set of
 * MessageType values the user wants pinged on (per CLAUDE.md phase-1
 * notification granularity). `pushSubscriptions` is a JSON array of Web Push
 * sub records (multiple devices supported).
 *
 * Deferred:
 *   - KMS encryption-at-rest custom resolver for `discordWebhookUrl` (it is a
 *     credential — must not be returned in plaintext to non-owner / non-admin).
 *     The field is stored raw for now; access is owner-only via authz.
 *   - Lazy-create resolver that initializes the row on first preference read.
 *   - Phase 5 fan-out Lambda consumes this model.
 */
export const NotificationPreference = a
  .model({
    userId: a.id().required(),
    user: a.belongsTo('User', 'userId'),
    emailEnabled: a.boolean().default(false),
    pushEnabled: a.boolean().default(false),
    discordWebhookEnabled: a.boolean().default(false),
    discordWebhookUrl: a.string(),
    subscribedTypes: a.string().array(),
    pushSubscriptions: a.json(),
    weeklyDigest: a.boolean().default(false),
  })
  .identifier(['userId'])
  .authorization((allow) => [
    allow.owner().to(['read', 'create', 'update']),
    allow.groups(['admin']).to(['read']),
  ]);
