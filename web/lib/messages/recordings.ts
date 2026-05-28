'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

export type DisplayRecording = {
  id: string;
  frequencyKhz: number | null;
  modulation: 'USB' | 'LSB' | 'AM' | 'FM' | null;
  broadcastedAt: string | null;
  transcript: string | null;
  transcriptionStatus: string | null;
  transcriptionFailed: boolean;
  durationMs: number | null;
  sdrId: string | null;
  automated: boolean;
  webCanonicalKey: string | null;
  wordTimestampsKey: string | null;
  peaksJsonKey: string | null;
};

type RawRecording = {
  id: string;
  frequencyKhz?: number | null;
  modulation?: 'USB' | 'LSB' | 'AM' | 'FM' | null;
  broadcastedAt?: string | null;
  transcript?: string | null;
  transcriptionStatus?: string | null;
  transcriptionFailed?: boolean | null;
  durationMs?: number | null;
  sdrId?: string | null;
  automated?: boolean | null;
  webCanonicalKey?: string | null;
  wordTimestampsKey?: string | null;
  peaksJsonKey?: string | null;
};

function toDisplay(r: RawRecording): DisplayRecording {
  return {
    id: r.id,
    frequencyKhz: typeof r.frequencyKhz === 'number' ? r.frequencyKhz : null,
    modulation: r.modulation ?? null,
    broadcastedAt: r.broadcastedAt ?? null,
    transcript: r.transcript ?? null,
    transcriptionStatus: r.transcriptionStatus ?? null,
    transcriptionFailed: Boolean(r.transcriptionFailed),
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
    sdrId: r.sdrId ?? null,
    automated: Boolean(r.automated),
    webCanonicalKey: r.webCanonicalKey ?? null,
    wordTimestampsKey: r.wordTimestampsKey ?? null,
    peaksJsonKey: r.peaksJsonKey ?? null,
  };
}

export { toDisplay as toDisplayRecording };

type RawRecordingListResult = {
  data?: RawRecording[] | null;
  errors?: { message: string }[] | null;
};

export async function listRecordingsForMessage(messageId: string): Promise<DisplayRecording[]> {
  const client = getDataClient();
  // Cast through `unknown` so the type-aware checker skips the
  // Schema's recursive filter generics (TS2589 surfaced in the
  // matching Message.list path).
  const listFn = client.models.Recording.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawRecordingListResult>;
  const authMode = await resolveAuthMode();
  const raw = await listFn({
    filter: {
      and: [{ messageId: { eq: messageId } }, { deletedAt: { attributeExists: false } }],
    },
    authMode,
  });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  return (raw.data ?? []).map(toDisplay);
}
