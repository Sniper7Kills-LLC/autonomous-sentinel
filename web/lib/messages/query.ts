'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';
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
  };
}

export interface ListMessagesOptions {
  filters?: MessageFilters;
  pageSize?: number;
  nextToken?: string | null;
}

export interface ListMessagesWithFilterOptions {
  filter?: Record<string, unknown>;
  pageSize?: number;
  nextToken?: string | null;
}

/**
 * Low-level published-Message list keyed on a pre-built AppSync model
 * filter. `listMessages` derives its filter from `MessageFilters`;
 * search (#87) builds a richer `contains`-OR filter and feeds it here
 * directly. Either way the same `iam` public-read path + soft-delete
 * exclusion (baked into the caller's filter) applies.
 */
export async function listMessagesWithFilter(
  opts: ListMessagesWithFilterOptions = {},
): Promise<ListResult> {
  const client = getDataClient();
  const args: RawListArgs = {
    filter: opts.filter,
    limit: opts.pageSize ?? DEFAULT_PAGE_SIZE,
  };
  if (opts.nextToken) args.nextToken = opts.nextToken;
  // Cast the model accessor to `unknown` first so the type-aware
  // checker does not chase the Schema's recursive filter generics
  // (TS2589 "excessively deep" on `Parameters<...>[0]`). Response
  // shape is structurally validated via `RawListResult`.
  const listFn = client.models.Message.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const raw = await listFn({ ...args, authMode });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  const rows = raw.data ?? [];
  return {
    items: rows.map(toDisplayMessage),
    nextToken: raw.nextToken ?? null,
  };
}

/**
 * List published Messages matching the filters. Returns the next-page
 * cursor in `nextToken` when more rows are available.
 *
 * Public-facing browse — uses `iam` auth so guests get the same view
 * the Amplify Data resource grants `allow.guest().to(['read'])`.
 */
export async function listMessages(opts: ListMessagesOptions = {}): Promise<ListResult> {
  return listMessagesWithFilter({
    filter: filtersToAppSyncFilter(opts.filters ?? {}),
    pageSize: opts.pageSize,
    nextToken: opts.nextToken,
  });
}

export async function getMessage(id: string): Promise<DisplayMessage | null> {
  const client = getDataClient();
  const getFn = client.models.Message.get as unknown as (
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<RawGetResult>;
  const authMode = await resolveAuthMode();
  const raw = await getFn({ id }, { authMode });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) return null;
  return toDisplayMessage(raw.data);
}
