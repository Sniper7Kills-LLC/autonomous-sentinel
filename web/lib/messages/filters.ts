/**
 * URL <-> filter state plumbing for the public messages list (#76).
 *
 * Filter state is the URL — refresh, share-link, back/forward all need to
 * round-trip the same query without a separate state container. These
 * helpers parse `URLSearchParams` into a typed `MessageFilters` and
 * serialize back for `router.replace` calls.
 *
 * Only fields with a known semantic land in the URL. Garbage / unknown
 * keys are dropped on the read path so a paste-in URL can't poison the
 * query.
 */
import { z } from 'zod';

export const MESSAGE_TYPES = [
  'BACKEND',
  'SKYKING',
  'ALLSTATIONS',
  'RADIOCHECK',
  'SKYMASTER',
  'SKYBIRD',
  'DISREGARDED',
  'OTHER',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

const TypeSchema = z.enum(MESSAGE_TYPES);
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'invalid calendar date');
const TextSchema = z.string().min(1).max(120);

export const MessageFiltersSchema = z.object({
  type: TypeSchema.optional(),
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  sender: TextSchema.optional(),
  receiver: TextSchema.optional(),
});

export type MessageFilters = z.infer<typeof MessageFiltersSchema>;

export function parseFiltersFromParams(params: URLSearchParams): MessageFilters {
  const raw = {
    type: params.get('type') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    sender: params.get('sender') ?? undefined,
    receiver: params.get('receiver') ?? undefined,
  };
  const result = MessageFiltersSchema.safeParse(raw);
  if (result.success) return result.data;
  // Drop only the invalid keys, preserve the valid ones.
  const partial: MessageFilters = {};
  for (const key of ['type', 'from', 'to', 'sender', 'receiver'] as const) {
    const single = MessageFiltersSchema.pick({ [key]: true } as Record<typeof key, true>).safeParse(
      {
        [key]: raw[key],
      },
    );
    if (single.success) {
      const v = single.data[key];
      if (v !== undefined) partial[key] = v as never;
    }
  }
  return partial;
}

export function serializeFiltersToParams(filters: MessageFilters): URLSearchParams {
  const out = new URLSearchParams();
  if (filters.type) out.set('type', filters.type);
  if (filters.from) out.set('from', filters.from);
  if (filters.to) out.set('to', filters.to);
  if (filters.sender) out.set('sender', filters.sender);
  if (filters.receiver) out.set('receiver', filters.receiver);
  return out;
}

/**
 * Translate filters into the AppSync model filter expression the
 * generated `Message.list` query expects. Date filters bracket
 * `broadcastTs` (ISO UTC midnight start, end-of-day end).
 */
export function filtersToAppSyncFilter(
  filters: MessageFilters,
): Record<string, unknown> | undefined {
  const and: Record<string, unknown>[] = [];
  if (filters.type) and.push({ type: { eq: filters.type } });
  if (filters.from) and.push({ broadcastTs: { ge: `${filters.from}T00:00:00.000Z` } });
  if (filters.to) and.push({ broadcastTs: { le: `${filters.to}T23:59:59.999Z` } });
  if (filters.sender) and.push({ sender: { contains: filters.sender } });
  if (filters.receiver) and.push({ receiver: { contains: filters.receiver } });
  // Exclude soft-deleted rows from public list.
  and.push({ deletedAt: { attributeExists: false } });
  if (and.length === 1) return and[0];
  return { and };
}

export function isFiltersEmpty(filters: MessageFilters): boolean {
  return (
    filters.type === undefined &&
    filters.from === undefined &&
    filters.to === undefined &&
    filters.sender === undefined &&
    filters.receiver === undefined
  );
}
