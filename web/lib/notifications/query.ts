'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { MESSAGE_TYPES, type MessageType } from '@/lib/messages/filters';

export interface NotificationPrefView {
  userId: string;
  emailEnabled: boolean;
  pushEnabled: boolean;
  discordWebhookEnabled: boolean;
  /** Returned plaintext when the caller is the owner (Lambda KMS-decrypts). */
  discordWebhookUrl: string | null;
  subscribedTypes: MessageType[];
  weeklyDigest: boolean;
}

type RawView = {
  userId: string;
  emailEnabled?: boolean | null;
  pushEnabled?: boolean | null;
  discordWebhookEnabled?: boolean | null;
  discordWebhookUrl?: string | null;
  subscribedTypes?: (string | null | undefined)[] | null;
  weeklyDigest?: boolean | null;
};

type RawWrapper<T> = {
  data?: T | null;
  errors?: { message: string }[] | null;
};

function isMessageType(v: unknown): v is MessageType {
  return typeof v === 'string' && (MESSAGE_TYPES as readonly string[]).includes(v);
}

function toView(r: RawView): NotificationPrefView {
  const types: MessageType[] = [];
  for (const t of r.subscribedTypes ?? []) {
    if (isMessageType(t)) types.push(t);
  }
  return {
    userId: r.userId,
    emailEnabled: Boolean(r.emailEnabled),
    pushEnabled: Boolean(r.pushEnabled),
    discordWebhookEnabled: Boolean(r.discordWebhookEnabled),
    discordWebhookUrl: r.discordWebhookUrl ?? null,
    subscribedTypes: types,
    weeklyDigest: Boolean(r.weeklyDigest),
  };
}

export async function getMyNotificationPreference(): Promise<NotificationPrefView> {
  const client = getDataClient();
  const fn = client.queries.getMyNotificationPreference as unknown as (
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<RawWrapper<RawView>>;
  const raw = await fn({}, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) throw new Error('getMyNotificationPreference: empty response');
  return toView(raw.data);
}

export interface NotificationPrefUpdate {
  emailEnabled?: boolean;
  pushEnabled?: boolean;
  discordWebhookEnabled?: boolean;
  /** Plaintext Discord webhook URL; Lambda KMS-encrypts before storage. */
  discordWebhookUrl?: string | null;
  subscribedTypes?: MessageType[];
  weeklyDigest?: boolean;
}

export async function setNotificationPreference(
  patch: NotificationPrefUpdate,
): Promise<NotificationPrefView> {
  const client = getDataClient();
  const fn = client.mutations.setNotificationPreference as unknown as (
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<RawWrapper<RawView>>;
  const args: Record<string, unknown> = {};
  if (patch.emailEnabled !== undefined) args.emailEnabled = patch.emailEnabled;
  if (patch.pushEnabled !== undefined) args.pushEnabled = patch.pushEnabled;
  if (patch.discordWebhookEnabled !== undefined)
    args.discordWebhookEnabled = patch.discordWebhookEnabled;
  if (patch.discordWebhookUrl !== undefined) args.discordWebhookUrl = patch.discordWebhookUrl;
  if (patch.subscribedTypes !== undefined) args.subscribedTypes = patch.subscribedTypes;
  if (patch.weeklyDigest !== undefined) args.weeklyDigest = patch.weeklyDigest;
  const raw = await fn(args, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) throw new Error('setNotificationPreference: empty response');
  return toView(raw.data);
}
