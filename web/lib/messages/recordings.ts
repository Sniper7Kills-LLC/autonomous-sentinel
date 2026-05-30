'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * One entry of `Recording.linguisticAttempts` (#561 debug aids).
 *
 * The Linguistic Logic Lambda writes an append-only JSON log of
 * `{provider, promptVersion, promptHash, resultHash, timestamp}`
 * entries. `success` is surfaced when present; some historical rows
 * use `ts` for the timestamp, so the parser tolerates both keys.
 */
export type LinguisticAttempt = {
  provider: string | null;
  success: boolean | null;
  promptVersion: number | null;
  promptHash: string | null;
  resultHash: string | null;
  ts: string | null;
};

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
  /**
   * Parsed `Recording.linguisticAttempts` (raw AWSJSON). Empty array
   * when absent/unparseable. Only rendered in the moderator/admin-only
   * debug panel (#561).
   */
  linguisticAttempts: LinguisticAttempt[];
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
  // AWSJSON — arrives as a parsed value (array/object) or a JSON
  // string depending on the client path; the parser handles both.
  linguisticAttempts?: unknown;
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseAttempts(raw: unknown): LinguisticAttempt[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      provider: str(e.provider),
      success: typeof e.success === 'boolean' ? e.success : null,
      promptVersion: num(e.promptVersion),
      promptHash: str(e.promptHash),
      resultHash: str(e.resultHash),
      // Lambda writes `timestamp`; older rows used `ts`.
      ts: str(e.ts) ?? str(e.timestamp),
    }));
}

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
    linguisticAttempts: parseAttempts(r.linguisticAttempts),
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
