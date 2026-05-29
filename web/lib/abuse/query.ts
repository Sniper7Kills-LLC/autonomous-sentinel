'use client';

import { getDataClient } from '@/lib/amplifyClient';

export type AbuseTargetType = 'MESSAGE' | 'RECORDING' | 'COMMENT' | 'USER';
export type AbuseReason = 'SPAM' | 'OFFENSIVE' | 'WRONG_INFO' | 'IMPERSONATION' | 'OTHER';

export interface SubmitAbuseReportInput {
  targetType: AbuseTargetType;
  targetId: string;
  reporterId: string;
  reason: AbuseReason;
  notes?: string;
}

type RawCreateResult = {
  data?: { id?: string } | null;
  errors?: { message: string }[] | null;
};

/**
 * Submit an `AbuseReport` row via the auto-generated `createAbuseReport`
 * mutation. The model authz (`allow.authenticated().to(['create'])` +
 * the #430 group sweep) restricts callers to signed-in users; the
 * resolver derives `reporterId` server-side from the JWT — we pass it
 * here to keep the row shape complete, but the server is the source of
 * truth for that column.
 */
export async function submitAbuseReport(input: SubmitAbuseReportInput): Promise<string> {
  const client = getDataClient();
  const fn = client.models.AbuseReport.create as unknown as (
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<RawCreateResult>;
  const args: Record<string, unknown> = {
    reporterId: input.reporterId,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    status: 'OPEN',
  };
  if (input.notes && input.notes.trim().length > 0) {
    args.notes = input.notes.trim();
  }
  const raw = await fn(args, { authMode: 'userPool' });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  if (!raw.data?.id) throw new Error('submitAbuseReport: empty response');
  return raw.data.id;
}
