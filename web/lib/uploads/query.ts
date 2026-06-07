'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';
import { toDisplayRecording as toDisplay, type DisplayRecording } from '@/lib/messages/recordings';

/**
 * `My Uploads` data layer (#94). Lists every Recording owned by
 * the current Cognito sub, sorted by upload time desc. Uses the
 * existing `Recording.uploaderId` GSI so the query stays cheap as
 * the contributor's history grows.
 */

type RawRecording = {
  id: string;
  uploaderId?: string | null;
  messageId?: string | null;
  contentHash?: string | null;
  originalKey?: string | null;
  webCanonicalKey?: string | null;
  wordTimestampsKey?: string | null;
  peaksJsonKey?: string | null;
  transcript?: string | null;
  transcriptionStatus?: string | null;
  transcriptionStatusUpdatedAt?: string | null;
  transcriptionFailed?: boolean | null;
  failedReason?: string | null;
  frequencyKhz?: number | null;
  modulation?: 'USB' | 'LSB' | 'AM' | 'FM' | null;
  broadcastedAt?: string | null;
  durationMs?: number | null;
  sdrId?: string | null;
  automated?: boolean | null;
  createdAt?: string | null;
};

type RawListResult = {
  data?: RawRecording[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

export interface UploadRow extends DisplayRecording {
  messageId: string | null;
  failedReason: string | null;
  transcriptionStatusUpdatedAt: string | null;
  createdAt: string | null;
  originalKey: string | null;
}

export function toUploadRow(r: RawRecording): UploadRow {
  const base = toDisplay({
    id: r.id,
    frequencyKhz: r.frequencyKhz ?? null,
    modulation: r.modulation ?? null,
    broadcastedAt: r.broadcastedAt ?? null,
    transcript: r.transcript ?? null,
    transcriptionStatus: r.transcriptionStatus ?? null,
    transcriptionFailed: r.transcriptionFailed ?? null,
    durationMs: r.durationMs ?? null,
    sdrId: r.sdrId ?? null,
    automated: r.automated ?? false,
    webCanonicalKey: r.webCanonicalKey ?? null,
    wordTimestampsKey: r.wordTimestampsKey ?? null,
    peaksJsonKey: r.peaksJsonKey ?? null,
  });
  return {
    ...base,
    messageId: r.messageId ?? null,
    failedReason: r.failedReason ?? null,
    transcriptionStatusUpdatedAt: r.transcriptionStatusUpdatedAt ?? null,
    createdAt: r.createdAt ?? null,
    originalKey: r.originalKey ?? null,
  };
}

export interface ListUploadsResult {
  items: UploadRow[];
  nextToken: string | null;
}

export interface ListUploadsOptions {
  pageSize?: number;
  nextToken?: string | null;
}

export async function listMyUploads(
  uploaderId: string,
  opts: ListUploadsOptions = {},
): Promise<ListUploadsResult> {
  const client = getDataClient();
  const listFn = client.models.Recording.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const args: Record<string, unknown> = {
    filter: {
      and: [{ uploaderId: { eq: uploaderId } }, { deletedAt: { attributeExists: false } }],
    },
    limit: opts.pageSize ?? 50,
    authMode,
  };
  if (opts.nextToken) args.nextToken = opts.nextToken;
  const raw = await listFn(args);
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  const rows = (raw.data ?? []).map(toUploadRow);
  // Sort by createdAt desc; AppSync filter does not guarantee order.
  rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { items: rows, nextToken: raw.nextToken ?? null };
}

/** Minimal subscription handle returned by `observeMyUploads`. */
export interface UploadsSubscription {
  unsubscribe: () => void;
}

export interface ObserveMyUploadsHandlers {
  /** Full, sorted (newest-first) snapshot on every sync tick. */
  next: (rows: UploadRow[]) => void;
  error?: (err: unknown) => void;
}

/**
 * Live `My Uploads` (#774). Subscribes to the caller's Recordings via
 * AppSync `observeQuery` so pipeline-status changes (incl. an admin
 * reprocess) surface in real time without a manual refresh. `observeQuery`
 * keeps a full synced snapshot, so each `next` delivers the complete set —
 * sorted newest-first here, mapped to UploadRow.
 *
 * Uses the `userPool` auth mode (the GSI read is group/owner-gated; the
 * identity-pool path doesn't carry the claim). Returns a handle whose
 * `unsubscribe` the caller must invoke on unmount.
 */
export function observeMyUploads(
  uploaderId: string,
  handlers: ObserveMyUploadsHandlers,
): UploadsSubscription {
  const client = getDataClient();
  const observe = client.models.Recording.observeQuery as unknown as (input: {
    filter: Record<string, unknown>;
    authMode: 'userPool';
  }) => {
    subscribe: (cbs: {
      next: (snap: { items: RawRecording[] }) => void;
      error?: (err: unknown) => void;
    }) => UploadsSubscription;
  };
  return observe({
    filter: {
      and: [{ uploaderId: { eq: uploaderId } }, { deletedAt: { attributeExists: false } }],
    },
    authMode: 'userPool',
  }).subscribe({
    next: ({ items }) => {
      const rows = items.map(toUploadRow);
      rows.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      handlers.next(rows);
    },
    error: (err) => handlers.error?.(err),
  });
}

/**
 * Maps the `Recording.transcriptionStatus` enum to a human label +
 * tone for the dashboard pill. Mirrors the testing-portal pipeline-
 * stage palette in `<UploadFlow>` but exposes the full failure
 * variants so a contributor can see WHICH stage failed.
 */
export type UploadStage =
  | 'queued'
  | 'preprocessing'
  | 'preprocess_failed'
  | 'transcribing'
  | 'transcribe_failed'
  | 'parsing'
  | 'parse_failed'
  | 'published'
  | 'failed'
  | 'unknown';

export function statusToStage(raw: string | null | undefined): UploadStage {
  switch (raw) {
    case 'QUEUED':
      return 'queued';
    case 'PREPROCESSING':
      return 'preprocessing';
    case 'PREPROCESS_FAILED':
      return 'preprocess_failed';
    case 'TRANSCRIBING':
      return 'transcribing';
    case 'TRANSCRIBE_FAILED':
      return 'transcribe_failed';
    case 'PARSING':
      return 'parsing';
    case 'PARSE_FAILED':
      return 'parse_failed';
    case 'PUBLISHED':
      return 'published';
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}
