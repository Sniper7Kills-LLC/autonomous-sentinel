'use client';

import { getDataClient } from '@/lib/amplifyClient';

/**
 * Admin DLQ + manual-reprocess data layer (#107).
 *
 * Thin wrappers over the admin-only `listDlqMessages` query +
 * `requeueDlqMessage` / `dropDlqMessage` mutations (resolved by the
 * `dlqAdmin` Lambda). All three return an `a.json()` scalar, which
 * Amplify may hand back as a parsed object or a JSON string depending on
 * codegen — `coerceJson` normalises both.
 *
 * Every call uses the Cognito `userPool` token: the operations are
 * admin-gated server-side, so a guest / non-admin call returns
 * Unauthorized.
 */

export const PIPELINE_STAGES = ['preprocess', 'transcribe', 'linguistic'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface DlqMessageView {
  stage: PipelineStage;
  messageId: string;
  receiptHandle: string;
  body: string;
  recordingId: string | null;
  approximateReceiveCount: number;
  enqueuedAt: string | null;
  errorReason: string | null;
}

interface RawResult {
  data?: unknown;
  errors?: { message: string }[] | null;
}

function coerceJson(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Narrow one raw message object into the view type. */
export function toDlqMessageView(raw: unknown, stage: PipelineStage): DlqMessageView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const messageId = str(r.messageId);
  const receiptHandle = str(r.receiptHandle);
  if (!messageId || !receiptHandle) return null;
  return {
    stage,
    messageId,
    receiptHandle,
    body: typeof r.body === 'string' ? r.body : '',
    recordingId: str(r.recordingId),
    approximateReceiveCount: num(r.approximateReceiveCount),
    enqueuedAt: str(r.enqueuedAt),
    errorReason: str(r.errorReason),
  };
}

function throwOnErrors(res: RawResult): void {
  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join('; '));
  }
}

/** Peek the requested stage's DLQ (no delete). */
export async function listDlqMessages(stage: PipelineStage): Promise<DlqMessageView[]> {
  const client = getDataClient();
  const queryFn = (
    client.queries as unknown as {
      listDlqMessages: (
        input: { stage: string },
        opts: { authMode: 'userPool' },
      ) => Promise<RawResult>;
    }
  ).listDlqMessages;
  const res = await queryFn({ stage }, { authMode: 'userPool' });
  throwOnErrors(res);
  const payload = coerceJson(res.data);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages
    .map((m) => toDlqMessageView(m, stage))
    .filter((m): m is DlqMessageView => m !== null);
}

/** Send a stuck message back onto its stage's primary queue. */
export async function requeueDlqMessage(msg: DlqMessageView): Promise<void> {
  const client = getDataClient();
  const mutateFn = (
    client.mutations as unknown as {
      requeueDlqMessage: (
        input: {
          stage: string;
          receiptHandle: string;
          body: string;
          recordingId?: string;
          messageId: string;
        },
        opts: { authMode: 'userPool' },
      ) => Promise<RawResult>;
    }
  ).requeueDlqMessage;
  const res = await mutateFn(
    {
      stage: msg.stage,
      receiptHandle: msg.receiptHandle,
      body: msg.body,
      messageId: msg.messageId,
      ...(msg.recordingId ? { recordingId: msg.recordingId } : {}),
    },
    { authMode: 'userPool' },
  );
  throwOnErrors(res);
}

/** Permanently drop a stuck message + mark its Recording terminally FAILED. */
export async function dropDlqMessage(msg: DlqMessageView): Promise<void> {
  const client = getDataClient();
  const mutateFn = (
    client.mutations as unknown as {
      dropDlqMessage: (
        input: { stage: string; receiptHandle: string; recordingId?: string; messageId: string },
        opts: { authMode: 'userPool' },
      ) => Promise<RawResult>;
    }
  ).dropDlqMessage;
  const res = await mutateFn(
    {
      stage: msg.stage,
      receiptHandle: msg.receiptHandle,
      messageId: msg.messageId,
      ...(msg.recordingId ? { recordingId: msg.recordingId } : {}),
    },
    { authMode: 'userPool' },
  );
  throwOnErrors(res);
}
