'use client';

import { getDataClient } from '@/lib/amplifyClient';

export type DisplayRecording = {
  id: string;
  frequencyKhz: number | null;
  modulation: 'USB' | 'LSB' | 'AM' | 'FM' | null;
  broadcastedAt: string | null;
  transcript: string | null;
  transcriptionStatus: string | null;
  durationMs: number | null;
  sdrId: string | null;
  automated: boolean;
};

type RawRecording = {
  id: string;
  frequencyKhz?: number | null;
  modulation?: 'USB' | 'LSB' | 'AM' | 'FM' | null;
  broadcastedAt?: string | null;
  transcript?: string | null;
  transcriptionStatus?: string | null;
  durationMs?: number | null;
  sdrId?: string | null;
  automated?: boolean | null;
};

function toDisplay(r: RawRecording): DisplayRecording {
  return {
    id: r.id,
    frequencyKhz: typeof r.frequencyKhz === 'number' ? r.frequencyKhz : null,
    modulation: r.modulation ?? null,
    broadcastedAt: r.broadcastedAt ?? null,
    transcript: r.transcript ?? null,
    transcriptionStatus: r.transcriptionStatus ?? null,
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
    sdrId: r.sdrId ?? null,
    automated: Boolean(r.automated),
  };
}

export { toDisplay as toDisplayRecording };

type RawRecordingListResult = {
  data?: RawRecording[] | null;
  errors?: { message: string }[] | null;
};

export async function listRecordingsForMessage(messageId: string): Promise<DisplayRecording[]> {
  const client = getDataClient();
  const raw = (await client.models.Recording.list({
    filter: {
      and: [{ messageId: { eq: messageId } }, { deletedAt: { attributeExists: false } }],
    },
    authMode: 'identityPool',
  })) as unknown as RawRecordingListResult;
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  return (raw.data ?? []).map(toDisplay);
}
