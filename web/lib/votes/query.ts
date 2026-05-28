'use client';

import { getDataClient } from '@/lib/amplifyClient';

export type FieldVoteField = 'SENDER' | 'RECEIVER' | 'BODY' | 'TYPE';

export interface DisplayFieldVote {
  fieldKey: string;
  messageId: string;
  field: FieldVoteField;
  value: string;
  voterId: string;
  weightAtVoteTime: number;
  firstCastAt: string | null;
  lastCastAt: string | null;
}

export interface FieldVoteTally {
  /** Sorted entries: { value, weight, voterCount }, weight desc. */
  entries: Array<{ value: string; weight: number; voterCount: number }>;
  total: number;
}

type RawFieldVote = {
  fieldKey: string;
  messageId: string;
  field: string;
  value: string;
  voterId: string;
  weightAtVoteTime?: number | null;
  firstCastAt?: string | null;
  lastCastAt?: string | null;
};

type RawListResult = {
  data?: RawFieldVote[] | null;
  errors?: { message: string }[] | null;
};

type RawCastResult = {
  data?: RawFieldVote | null;
  errors?: { message: string }[] | null;
};

function isField(v: unknown): v is FieldVoteField {
  return v === 'SENDER' || v === 'RECEIVER' || v === 'BODY' || v === 'TYPE';
}

export function toDisplayFieldVote(r: RawFieldVote): DisplayFieldVote | null {
  if (!isField(r.field)) return null;
  return {
    fieldKey: r.fieldKey,
    messageId: r.messageId,
    field: r.field,
    value: r.value,
    voterId: r.voterId,
    weightAtVoteTime: typeof r.weightAtVoteTime === 'number' ? r.weightAtVoteTime : 1,
    firstCastAt: r.firstCastAt ?? null,
    lastCastAt: r.lastCastAt ?? null,
  };
}

/**
 * List FieldVote rows for a single Message + field combination.
 *
 * The FieldVote model authz is `allow.authenticated().to(['read'])`
 * + mod/admin raw read — guests get no rows. Until the deferred
 * aggregate-only public resolver lands (#33), the UI hides the
 * vote tally from signed-out visitors.
 */
export async function listFieldVotes(
  messageId: string,
  field: FieldVoteField,
): Promise<DisplayFieldVote[]> {
  const client = getDataClient();
  const listFn = client.models.FieldVote.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const raw = await listFn({
    filter: {
      and: [{ messageId: { eq: messageId } }, { field: { eq: field } }],
    },
    authMode: 'userPool',
  });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  const out: DisplayFieldVote[] = [];
  for (const r of raw.data ?? []) {
    const v = toDisplayFieldVote(r);
    if (v) out.push(v);
  }
  return out;
}

export async function castFieldVote(
  messageId: string,
  field: FieldVoteField,
  value: string,
): Promise<void> {
  const client = getDataClient();
  const castFn = client.mutations.castFieldVote as unknown as (
    input: { messageId: string; field: FieldVoteField; value: string },
    opts: Record<string, unknown>,
  ) => Promise<RawCastResult>;
  const raw = await castFn({ messageId, field, value }, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
}

/**
 * Pure aggregator — exposed for tests + the popover. Groups by
 * `value`, sums `weightAtVoteTime`, sorts by weight desc.
 */
export function tallyFieldVotes(votes: DisplayFieldVote[]): FieldVoteTally {
  const buckets = new Map<string, { weight: number; voterCount: number }>();
  let total = 0;
  for (const v of votes) {
    const w = v.weightAtVoteTime;
    const existing = buckets.get(v.value) ?? { weight: 0, voterCount: 0 };
    existing.weight += w;
    existing.voterCount += 1;
    buckets.set(v.value, existing);
    total += w;
  }
  const entries = [...buckets.entries()]
    .map(([value, agg]) => ({ value, weight: agg.weight, voterCount: agg.voterCount }))
    .sort((a, b) => b.weight - a.weight);
  return { entries, total };
}
