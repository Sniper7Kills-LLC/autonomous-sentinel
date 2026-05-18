import type { AppSyncResolverHandler } from 'aws-lambda';
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * `notificationPreferenceMutations` Lambda (#288).
 *
 * Two AppSync fields share this handler — dispatch is on
 * `event.info.fieldName`:
 *
 *   - `setNotificationPreference` (mutation): upserts the caller's own
 *     NotificationPreference row. The plaintext `discordWebhookUrl`
 *     input is run through `KMS.Encrypt` before being written; the
 *     ciphertext is stored as base64 in the `discordWebhookUrlEnc`
 *     column. Callers can never set rows other than their own — the
 *     handler ignores any `userId` argument and pins the target to
 *     `identity.sub`. Returns the post-write view with the plaintext
 *     URL surfaced back to the owner.
 *
 *   - `getNotificationPreference` (query): returns the row for the
 *     caller's own sub. Admin callers may pass a `userId` argument to
 *     read another user's row. First read by the owner against a
 *     missing row lazy-creates a default row (so subsequent UI calls
 *     are simple PUTs); admin reads against a missing other-user row
 *     return null instead (no side-effect provisioning).
 *
 * Why Lambda (vs an AppSync JS pipeline): the `@aws-sdk/client-kms`
 * surface and the dependency-injected KMS / DDB stack are easier to
 * unit-test in TypeScript than to push through JS resolvers, and the
 * KMS call is a strict server-side concern that should not be visible
 * to AppSync at all.
 *
 * Dependency-injected for tests: production uses the env-var-driven
 * DDB + KMS defaults; tests inject `getRow` / `updateRow` / `encrypt`
 * / `decrypt` stubs that bypass AWS entirely.
 */

export type NotificationPreferenceRow = {
  userId: string;
  emailEnabled?: boolean | null;
  pushEnabled?: boolean | null;
  discordWebhookEnabled?: boolean | null;
  /** KMS-encrypted (base64) Discord webhook URL. Never returned raw. */
  discordWebhookUrlEnc?: string | null;
  subscribedTypes?: string[] | null;
  pushSubscriptions?: unknown;
  weeklyDigest?: boolean | null;
  [k: string]: unknown;
};

export type NotificationPreferenceView = {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  discordWebhookEnabled: boolean;
  /**
   * Decrypted plaintext when the caller is the owner OR is in the
   * admin group; null in every other case (including a missing /
   * unset stored value).
   */
  discordWebhookUrl: string | null;
  subscribedTypes: string[];
  pushSubscriptions: unknown;
  weeklyDigest: boolean;
};

export interface SetNotificationPreferenceInput {
  emailEnabled?: boolean | null;
  pushEnabled?: boolean | null;
  discordWebhookEnabled?: boolean | null;
  /** Plaintext URL; encrypted via KMS before storage. Null clears it. */
  discordWebhookUrl?: string | null;
  subscribedTypes?: string[] | null;
  pushSubscriptions?: unknown;
  weeklyDigest?: boolean | null;
}

export interface GetNotificationPreferenceArgs {
  userId?: string | null;
}

export interface NotificationPrefDeps {
  getRow: (userId: string) => Promise<NotificationPreferenceRow | null>;
  /**
   * Upserts a row: SETs every provided patch column and creates the
   * row if it does not exist. Used by `setNotificationPreference`;
   * does NOT enforce a conditional create — that's
   * `createDefaultRowIfMissing`'s job. Returns the resulting row.
   */
  updateRow: (
    userId: string,
    patch: Partial<NotificationPreferenceRow>,
  ) => Promise<NotificationPreferenceRow>;
  /**
   * Conditional create — writes `defaults` only when no row exists
   * for `userId`. On race (a concurrent setNotificationPreference or
   * a parallel first-read landed between our `getRow` and this
   * write), returns whatever the other writer left there instead of
   * clobbering it with defaults. Used exclusively by the get-side
   * lazy-create path.
   */
  createDefaultRowIfMissing: (
    userId: string,
    defaults: NotificationPreferenceRow,
  ) => Promise<NotificationPreferenceRow>;
  /** Returns base64-encoded ciphertext. */
  encrypt: (plaintext: string) => Promise<string>;
  /** Takes base64-encoded ciphertext, returns plaintext. */
  decrypt: (ciphertextB64: string) => Promise<string>;
}

let injected: Partial<NotificationPrefDeps> = {};

export function __setDeps(deps: Partial<NotificationPrefDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

const TABLE_ENV = 'NOTIFICATION_PREFERENCE_TABLE_NAME';
const KMS_KEY_ENV = 'KMS_KEY_ID';
const ADMIN_GROUP = 'admin';

function requireTableName(): string {
  const v = process.env[TABLE_ENV];
  if (!v) {
    throw new Error(`notificationPreferenceMutations: ${TABLE_ENV} env var is required`);
  }
  return v;
}

function requireKmsKeyId(): string {
  const v = process.env[KMS_KEY_ENV];
  if (!v) {
    throw new Error(`notificationPreferenceMutations: ${KMS_KEY_ENV} env var is required`);
  }
  return v;
}

let cachedKms: KMSClient | undefined;
function getKmsClient(): KMSClient {
  if (!cachedKms) cachedKms = new KMSClient({});
  return cachedKms;
}

async function defaultEncrypt(plaintext: string): Promise<string> {
  const res = await getKmsClient().send(
    new EncryptCommand({
      KeyId: requireKmsKeyId(),
      Plaintext: new TextEncoder().encode(plaintext),
    }),
  );
  if (!res.CiphertextBlob) {
    throw new Error('notificationPreferenceMutations: KMS.Encrypt returned no ciphertext');
  }
  return Buffer.from(res.CiphertextBlob).toString('base64');
}

async function defaultDecrypt(ciphertextB64: string): Promise<string> {
  const blob = Buffer.from(ciphertextB64, 'base64');
  const res = await getKmsClient().send(
    new DecryptCommand({
      KeyId: requireKmsKeyId(),
      CiphertextBlob: blob,
    }),
  );
  if (!res.Plaintext) {
    throw new Error('notificationPreferenceMutations: KMS.Decrypt returned no plaintext');
  }
  return new TextDecoder().decode(res.Plaintext);
}

async function defaultCreateDefaultRowIfMissing(
  userId: string,
  defaults: NotificationPreferenceRow,
): Promise<NotificationPreferenceRow> {
  try {
    await getDdbClient().send(
      new PutItemCommand({
        TableName: requireTableName(),
        Item: marshall(defaults, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(userId)',
      }),
    );
    return defaults;
  } catch (err: unknown) {
    const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : undefined;
    if (name === 'ConditionalCheckFailedException') {
      // Lost the race — another writer landed first. Re-fetch their
      // row so we never overwrite a concurrent set with our defaults.
      const fresh = await defaultGetRow(userId);
      if (fresh) return fresh;
      // The conditional only fails when the row exists, so a null
      // GetItem here implies a delete between the two operations.
      // Fall back to the defaults so callers don't crash.
      return defaults;
    }
    throw err;
  }
}

async function defaultGetRow(userId: string): Promise<NotificationPreferenceRow | null> {
  const res = await getDdbClient().send(
    new GetItemCommand({
      TableName: requireTableName(),
      Key: marshall({ userId }),
    }),
  );
  return res.Item ? (unmarshall(res.Item) as NotificationPreferenceRow) : null;
}

async function defaultUpdateRow(
  userId: string,
  patch: Partial<NotificationPreferenceRow>,
): Promise<NotificationPreferenceRow> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setClauses: string[] = [];
  let i = 0;
  for (const [col, val] of Object.entries(patch)) {
    if (col === 'userId') continue;
    const n = `#c${i}`;
    const v = `:v${i}`;
    names[n] = col;
    values[v] = val;
    setClauses.push(`${n} = ${v}`);
    i += 1;
  }
  if (setClauses.length === 0) {
    // Pure lazy-create with no fields to set — fall back to a no-op
    // touch on `userId` so DDB writes the bare row.
    const row: NotificationPreferenceRow = { userId };
    await getDdbClient().send(
      new UpdateItemCommand({
        TableName: requireTableName(),
        Key: marshall({ userId }),
        // DDB rejects an empty UpdateExpression; set userId to itself
        // to materialise the row without changing anything.
        UpdateExpression: 'SET #pk = :pk',
        ExpressionAttributeNames: { '#pk': 'userId' },
        ExpressionAttributeValues: marshall({ ':pk': userId }),
      }),
    );
    return row;
  }
  const res = await getDdbClient().send(
    new UpdateItemCommand({
      TableName: requireTableName(),
      Key: marshall({ userId }),
      UpdateExpression: `SET ${setClauses.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
      ReturnValues: 'ALL_NEW',
    }),
  );
  if (!res.Attributes) {
    // Should not happen with ReturnValues=ALL_NEW + a successful
    // UpdateItem, but stay defensive — fall back to the patch+key.
    return { userId, ...patch };
  }
  return unmarshall(res.Attributes) as NotificationPreferenceRow;
}

function resolveDeps(): NotificationPrefDeps {
  return {
    getRow: injected.getRow ?? defaultGetRow,
    updateRow: injected.updateRow ?? defaultUpdateRow,
    createDefaultRowIfMissing:
      injected.createDefaultRowIfMissing ?? defaultCreateDefaultRowIfMissing,
    encrypt: injected.encrypt ?? defaultEncrypt,
    decrypt: injected.decrypt ?? defaultDecrypt,
  };
}

function isAdmin(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf(ADMIN_GROUP) >= 0;
}

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function defaultDefaults(userId: string): NotificationPreferenceRow {
  // Mirrors the `default(false)` declarations on the model — keeps the
  // first-read view shape stable for the UI even when DDB returns a
  // bare row.
  return {
    userId,
    emailEnabled: false,
    pushEnabled: false,
    discordWebhookEnabled: false,
    discordWebhookUrlEnc: null,
    subscribedTypes: [],
    pushSubscriptions: null,
    weeklyDigest: false,
  };
}

async function toView(
  row: NotificationPreferenceRow,
  callerCanDecrypt: boolean,
  decrypt: NotificationPrefDeps['decrypt'],
): Promise<NotificationPreferenceView> {
  let url: string | null = null;
  if (
    callerCanDecrypt &&
    typeof row.discordWebhookUrlEnc === 'string' &&
    row.discordWebhookUrlEnc.length > 0
  ) {
    try {
      url = await decrypt(row.discordWebhookUrlEnc);
    } catch (err: unknown) {
      // KMS throttle / InvalidCiphertext / base64 decode failure —
      // degrade to "no webhook" rather than throwing a resolver
      // error. The owner can re-enter the URL via
      // setNotificationPreference if the stored ciphertext is
      // genuinely corrupt; raising here would block every other
      // preference (email, push, etc.) from rendering.
      console.warn(
        `notificationPreferenceMutations: decrypt failed for userId=${row.userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      url = null;
    }
  }
  return {
    userId: row.userId,
    emailEnabled: row.emailEnabled ?? false,
    pushEnabled: row.pushEnabled ?? false,
    discordWebhookEnabled: row.discordWebhookEnabled ?? false,
    discordWebhookUrl: url,
    subscribedTypes: row.subscribedTypes ?? [],
    pushSubscriptions: row.pushSubscriptions ?? null,
    weeklyDigest: row.weeklyDigest ?? false,
  };
}

async function dispatchSet(
  event: Parameters<
    AppSyncResolverHandler<SetNotificationPreferenceInput, NotificationPreferenceView>
  >[0],
  deps: NotificationPrefDeps,
): Promise<NotificationPreferenceView> {
  const sub = identitySub(event.identity);
  if (!sub) {
    throw new Error('setNotificationPreference: caller has no identity (not signed in)');
  }
  const args = event.arguments;

  // Build the DDB patch from only the provided keys. Undefined =
  // "untouched"; null = "clear". The plaintext webhook URL gets
  // KMS-encrypted into the storage column.
  const patch: Partial<NotificationPreferenceRow> = {};
  if ('emailEnabled' in args) patch.emailEnabled = args.emailEnabled ?? null;
  if ('pushEnabled' in args) patch.pushEnabled = args.pushEnabled ?? null;
  if ('discordWebhookEnabled' in args) {
    patch.discordWebhookEnabled = args.discordWebhookEnabled ?? null;
  }
  if ('subscribedTypes' in args) patch.subscribedTypes = args.subscribedTypes ?? null;
  if ('pushSubscriptions' in args) patch.pushSubscriptions = args.pushSubscriptions ?? null;
  if ('weeklyDigest' in args) patch.weeklyDigest = args.weeklyDigest ?? null;
  if ('discordWebhookUrl' in args) {
    const plaintext = args.discordWebhookUrl;
    if (typeof plaintext === 'string' && plaintext.length > 0) {
      patch.discordWebhookUrlEnc = await deps.encrypt(plaintext);
    } else {
      patch.discordWebhookUrlEnc = null;
    }
  }

  const stored = await deps.updateRow(sub, patch);
  // The caller is the owner by construction (we pinned sub) — surface
  // the just-set plaintext URL back without a redundant decrypt
  // round-trip when the patch carried one. Otherwise decrypt whatever
  // is stored.
  if ('discordWebhookUrl' in args) {
    const plaintext = args.discordWebhookUrl;
    return {
      ...(await toView(stored, false, deps.decrypt)),
      discordWebhookUrl: typeof plaintext === 'string' && plaintext.length > 0 ? plaintext : null,
    };
  }
  return toView(stored, true, deps.decrypt);
}

async function dispatchGet(
  event: Parameters<
    AppSyncResolverHandler<GetNotificationPreferenceArgs, NotificationPreferenceView | null>
  >[0],
  deps: NotificationPrefDeps,
): Promise<NotificationPreferenceView | null> {
  const callerSub = identitySub(event.identity);
  if (!callerSub) {
    throw new Error('getNotificationPreference: caller has no identity (not signed in)');
  }
  const callerIsAdmin = isAdmin(event.identity);
  const requested = event.arguments.userId;
  const target = typeof requested === 'string' && requested.length > 0 ? requested : callerSub;

  if (target !== callerSub && !callerIsAdmin) {
    throw new Error('getNotificationPreference: cross-user read requires admin group');
  }

  let row = await deps.getRow(target);
  if (row === null) {
    if (target !== callerSub) {
      // Admin reading another user's row that does not exist —
      // don't auto-provision; just return null.
      return null;
    }
    // Lazy-create on first owner-read: conditionally PUT the default
    // row. The conditional shape (`attribute_not_exists(userId)`)
    // means a concurrent `setNotificationPreference` from another
    // tab cannot be overwritten by our defaults — on race, we
    // re-fetch and return whatever the other writer left behind.
    row = await deps.createDefaultRowIfMissing(target, defaultDefaults(target));
  }

  const callerCanDecrypt = target === callerSub || callerIsAdmin;
  return toView(row, callerCanDecrypt, deps.decrypt);
}

export const handler: AppSyncResolverHandler<
  SetNotificationPreferenceInput | GetNotificationPreferenceArgs,
  NotificationPreferenceView | null
> = async (event) => {
  const deps = resolveDeps();
  const field = event.info.fieldName;
  switch (field) {
    case 'setNotificationPreference':
      return dispatchSet(
        event as Parameters<
          AppSyncResolverHandler<SetNotificationPreferenceInput, NotificationPreferenceView>
        >[0],
        deps,
      );
    case 'getNotificationPreference':
      return dispatchGet(
        event as Parameters<
          AppSyncResolverHandler<GetNotificationPreferenceArgs, NotificationPreferenceView | null>
        >[0],
        deps,
      );
    default:
      throw new Error(`notificationPreferenceMutations: unsupported fieldName "${field}"`);
  }
};
