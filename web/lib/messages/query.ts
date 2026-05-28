'use client';

import { getDataClient } from '@/lib/amplifyClient';
import {
  filtersToAppSyncFilter,
  type MessageFilters,
  MESSAGE_TYPES,
  type MessageType,
} from './filters';
import type { DisplayMessage, ListResult } from './types';

const DEFAULT_PAGE_SIZE = 25;

type RawListArgs = {
  filter?: Record<string, unknown>;
  limit?: number;
  nextToken?: string | null;
};

/**
 * Shape we expect back from `client.models.<X>.list`. The Amplify
 * Gen 2 generated `Schema` type fails to resolve when eslint runs
 * from monorepo root (cross-workspace import path is outside web/'s
 * `tsconfigRootDir`), so the wrapper coerces the response into this
 * structural shape — same fields, no Schema dependency.
 */
type RawListResult = {
  data?: RawRow[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

type RawGetResult = {
  data?: RawRow | null;
  errors?: { message: string }[] | null;
};

type RawRow = {
  id: string;
  type: string | null | undefined;
  broadcastTs: string | null | undefined;
  sender: string | null | undefined;
  receiver: string | null | undefined;
  body: string | null | undefined;
  confidence: number | null | undefined;
  flaggedForReview: boolean | null | undefined;
  publishedAt: string | null | undefined;
  characterCount: number | null | undefined;
  codewordCount: number | null | undefined;
};

function isMessageType(v: unknown): v is MessageType {
  return typeof v === 'string' && (MESSAGE_TYPES as readonly string[]).includes(v);
}

export function toDisplayMessage(r: RawRow): DisplayMessage {
  return {
    id: r.id,
    type: isMessageType(r.type) ? r.type : 'OTHER',
    broadcastTs: r.broadcastTs ?? '',
    sender: r.sender ?? null,
    receiver: r.receiver ?? null,
    body: r.body ?? null,
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    flaggedForReview: Boolean(r.flaggedForReview),
    publishedAt: r.publishedAt ?? null,
    characterCount: typeof r.characterCount === 'number' ? r.characterCount : null,
    codewordCount: typeof r.codewordCount === 'number' ? r.codewordCount : null,
  };
}

export interface ListMessagesOptions {
  filters?: MessageFilters;
  pageSize?: number;
  nextToken?: string | null;
}

/**
 * List published Messages matching the filters. Returns the next-page
 * cursor in `nextToken` when more rows are available.
 *
 * Public-facing browse — uses `iam` auth so guests get the same view
 * the Amplify Data resource grants `allow.guest().to(['read'])`.
 */
export async function listMessages(opts: ListMessagesOptions = {}): Promise<ListResult> {
  const client = getDataClient();
  const args: RawListArgs = {
    filter: filtersToAppSyncFilter(opts.filters ?? {}),
    limit: opts.pageSize ?? DEFAULT_PAGE_SIZE,
  };
  if (opts.nextToken) args.nextToken = opts.nextToken;
  const raw = (await client.models.Message.list({
    ...(args as Parameters<typeof client.models.Message.list>[0]),
    authMode: 'identityPool',
  })) as unknown as RawListResult;
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  const rows = raw.data ?? [];
  return {
    items: rows.map(toDisplayMessage),
    nextToken: raw.nextToken ?? null,
  };
}

export async function getMessage(id: string): Promise<DisplayMessage | null> {
  const client = getDataClient();
  const raw = (await client.models.Message.get(
    { id },
    { authMode: 'identityPool' },
  )) as unknown as RawGetResult;
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) return null;
  return toDisplayMessage(raw.data);
}
