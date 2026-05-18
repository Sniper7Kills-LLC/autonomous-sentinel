import { a } from '@aws-amplify/backend';
import { notificationPreferenceMutations } from '../../functions/notificationPreferenceMutations/resource';

/**
 * NotificationPreference — per-user channel toggles + per-message-type
 * subscription map (#41).
 *
 * 1:1 with User via `userId` identifier. `subscribedTypes` is the set of
 * MessageType values the user wants pinged on (per CLAUDE.md phase-1
 * notification granularity). `pushSubscriptions` is a JSON array of Web Push
 * sub records (multiple devices supported).
 *
 * Encryption-at-rest for the Discord webhook URL (#288): the storage
 * column is `discordWebhookUrlEnc` — base64-encoded KMS ciphertext.
 * Read + write only through `getNotificationPreference` /
 * `setNotificationPreference`, which decrypt / encrypt at the Lambda
 * boundary. Direct model reads on this column return the raw
 * ciphertext (no useful information without the KMS grant), which is
 * the intended safety net if a future code path forgets to use the
 * custom resolvers.
 *
 * Deferred:
 *   - Phase 5 fan-out Lambda consumes this model.
 */
export const NotificationPreference = a
  .model({
    // Cognito sub of the owning user — `User.id = cognitoSub` (#259).
    userId: a.id().required(),
    user: a.belongsTo('User', 'userId'),
    emailEnabled: a.boolean().default(false),
    pushEnabled: a.boolean().default(false),
    discordWebhookEnabled: a.boolean().default(false),
    /**
     * KMS-encrypted Discord webhook URL (base64 ciphertext). Never
     * write or read this column directly — use the
     * `setNotificationPreference` mutation / `getNotificationPreference`
     * query, which handle the KMS round-trip and the owner / admin
     * decrypt gate.
     */
    discordWebhookUrlEnc: a.string(),
    subscribedTypes: a.string().array(),
    pushSubscriptions: a.json(),
    weeklyDigest: a.boolean().default(false),
  })
  .identifier(['userId'])
  .authorization((allow) => [
    // Owner = the Cognito sub stored in `userId` (#259).
    allow.ownerDefinedIn('userId').identityClaim('sub').to(['read', 'create', 'update']),
    allow.groups(['admin']).to(['read']),
  ]);

/**
 * Response shape for the custom `getNotificationPreference` /
 * `setNotificationPreference` resolvers (#288). Mirrors the storage
 * model but exposes the **decrypted plaintext** Discord webhook URL
 * as `discordWebhookUrl` — and only when the caller is the owner OR
 * is in the admin group; in every other case the field is null.
 */
export const NotificationPreferenceView = a.customType({
  userId: a.id().required(),
  emailEnabled: a.boolean(),
  pushEnabled: a.boolean(),
  discordWebhookEnabled: a.boolean(),
  discordWebhookUrl: a.string(),
  subscribedTypes: a.string().array(),
  pushSubscriptions: a.json(),
  weeklyDigest: a.boolean(),
});

/**
 * `getNotificationPreference` (#288) — returns the caller's own row,
 * lazy-creating a default row on first access. Admin callers may pass
 * a `userId` to read another user's row (no auto-provision on
 * admin-side reads — returns null when missing). Non-admin callers
 * passing a `userId` that does not match their identity sub are
 * rejected.
 *
 * Lambda-backed so the KMS Encrypt / Decrypt + DDB SDK calls stay
 * out of the AppSync resolver runtime.
 */
export const getNotificationPreference = a
  .query()
  .arguments({ userId: a.id() })
  .returns(a.ref('NotificationPreferenceView'))
  .authorization((allow) => [allow.authenticated()])
  .handler(a.handler.function(notificationPreferenceMutations));

/**
 * `setNotificationPreference` (#288) — upserts the caller's own row.
 * The plaintext `discordWebhookUrl` argument is KMS-encrypted before
 * storage; null / empty clears the stored ciphertext. There is no
 * `userId` argument — callers can only ever modify their own row.
 */
export const setNotificationPreference = a
  .mutation()
  .arguments({
    emailEnabled: a.boolean(),
    pushEnabled: a.boolean(),
    discordWebhookEnabled: a.boolean(),
    discordWebhookUrl: a.string(),
    subscribedTypes: a.string().array(),
    pushSubscriptions: a.json(),
    weeklyDigest: a.boolean(),
  })
  .returns(a.ref('NotificationPreferenceView'))
  .authorization((allow) => [allow.authenticated()])
  .handler(a.handler.function(notificationPreferenceMutations));
