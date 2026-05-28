'use client';

import { getDataClient } from '@/lib/amplifyClient';

export type RevisionSource = 'MACHINE' | 'MANUAL' | 'CORRECTION';
export type RevisionVoteValue = 'UP' | 'DOWN';

export interface DisplayRevision {
  id: string;
  recordingId: string;
  proposedText: string;
  proposedBy: string;
  source: RevisionSource | null;
  voteScore: number;
  accepted: boolean;
  acceptedAt: string | null;
  superseded: boolean;
  createdAt: string | null;
}

type RawRevision = {
  id: string;
  recordingId: string;
  proposedText?: string | null;
  proposedBy?: string | null;
  source?: string | null;
  voteScore?: number | null;
  accepted?: boolean | null;
  acceptedAt?: string | null;
  superseded?: boolean | null;
  createdAt?: string | null;
};

function isSource(v: unknown): v is RevisionSource {
  return v === 'MACHINE' || v === 'MANUAL' || v === 'CORRECTION';
}

export function toDisplayRevision(r: RawRevision): DisplayRevision {
  return {
    id: r.id,
    recordingId: r.recordingId,
    proposedText: r.proposedText ?? '',
    proposedBy: r.proposedBy ?? '',
    source: isSource(r.source) ? r.source : null,
    voteScore: typeof r.voteScore === 'number' ? r.voteScore : 0,
    accepted: Boolean(r.accepted),
    acceptedAt: r.acceptedAt ?? null,
    superseded: Boolean(r.superseded),
    createdAt: r.createdAt ?? null,
  };
}

type RawRevisionList = {
  data?: RawRevision[] | null;
  errors?: { message: string }[] | null;
};

export async function listRevisionsForRecording(recordingId: string): Promise<DisplayRevision[]> {
  const client = getDataClient();
  const listFn = client.models.TranscriptRevision.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawRevisionList>;
  const raw = await listFn({
    filter: { recordingId: { eq: recordingId } },
    authMode: 'identityPool',
  });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  return (raw.data ?? []).map(toDisplayRevision);
}

type RawSubmitRevision = {
  data?: RawRevision | null;
  errors?: { message: string }[] | null;
};

export async function submitTranscriptRevision(
  recordingId: string,
  proposedText: string,
): Promise<DisplayRevision> {
  const client = getDataClient();
  const submitFn = client.mutations.submitTranscriptRevision as unknown as (
    input: { recordingId: string; proposedText: string },
    opts: Record<string, unknown>,
  ) => Promise<RawSubmitRevision>;
  const raw = await submitFn({ recordingId, proposedText }, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data) throw new Error('submitTranscriptRevision: empty response');
  return toDisplayRevision(raw.data);
}

type RawCastVote = {
  data?: { revisionId?: string; value?: string } | null;
  errors?: { message: string }[] | null;
};

export async function castRevisionVote(
  revisionId: string,
  value: RevisionVoteValue,
): Promise<void> {
  const client = getDataClient();
  const castFn = client.mutations.castRevisionVote as unknown as (
    input: { revisionId: string; value: RevisionVoteValue },
    opts: Record<string, unknown>,
  ) => Promise<RawCastVote>;
  const raw = await castFn({ revisionId, value }, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
}
