import { defineFunction } from '@aws-amplify/backend';

/**
 * `notificationPreferenceMutations` — Lambda-backed AppSync resolver
 * for `setNotificationPreference` mutation + `getNotificationPreference`
 * query (issue #288).
 *
 * Dispatches on `event.info.fieldName`:
 *   - `setNotificationPreference` — caller upserts their own row. The
 *     `discordWebhookUrl` plaintext input is run through `KMS.Encrypt`
 *     and stored as a base64 ciphertext in `discordWebhookUrlEnc`.
 *   - `getNotificationPreference` — returns the row for the caller's
 *     own sub (or the requested userId when the caller is admin),
 *     lazy-creating a default row on first access by the owner.
 *     `discordWebhookUrl` in the response is the decrypted plaintext
 *     only when the caller is the owner OR is in the admin group;
 *     other callers (none reach here in practice — admin-bypass is the
 *     only cross-user path) get null.
 *
 * Schema wiring lives in `data/models/notification-preference.ts`;
 * IAM grants (DDB GetItem/UpdateItem on the NotificationPreference
 * table, KMS Encrypt/Decrypt on the dedicated key) wire in
 * `amplify/backend.ts`.
 */
export const notificationPreferenceMutations = defineFunction({
  name: 'notificationPreferenceMutations',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
});
