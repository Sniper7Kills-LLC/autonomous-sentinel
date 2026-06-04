import { a } from '@aws-amplify/backend';
import { dlqAdmin } from '../../functions/dlqAdmin/resource';

/**
 * Admin DLQ + manual-reprocess custom operations (#107).
 *
 * All three are admin-only and resolved by the `dlqAdmin` Lambda. They
 * return `a.json()` (same pattern as `runCostSnapshotNow`) so the shape
 * can evolve without a schema migration — the web client narrows the
 * JSON to its view types.
 *
 *   - `listDlqMessages(stage)` — peek the stage's DLQ (no delete) and
 *     return the stuck messages with friendly metadata.
 *   - `requeueDlqMessage(stage, receiptHandle, body, recordingId?)` —
 *     send the body back onto the primary queue + delete from the DLQ.
 *   - `dropDlqMessage(stage, receiptHandle, recordingId?, reason?)` —
 *     delete from the DLQ + mark the Recording terminally FAILED.
 *
 * `stage` is a free string validated server-side against
 * {preprocess, transcribe, linguistic}; kept as `a.string()` rather than
 * a schema enum to avoid a second enum source-of-truth (the handler owns
 * the canonical list).
 */
export const listDlqMessages = a
  .query()
  .arguments({ stage: a.string().required() })
  .returns(a.json())
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(dlqAdmin));

export const requeueDlqMessage = a
  .mutation()
  .arguments({
    stage: a.string().required(),
    receiptHandle: a.string().required(),
    body: a.string().required(),
    recordingId: a.string(),
    // Re-received server-side to get a fresh delete handle (#731); the
    // peeked receiptHandle alone goes stale and no-ops the delete.
    messageId: a.string(),
  })
  .returns(a.json())
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(dlqAdmin));

export const dropDlqMessage = a
  .mutation()
  .arguments({
    stage: a.string().required(),
    receiptHandle: a.string().required(),
    recordingId: a.string(),
    reason: a.string(),
    // Re-received server-side to get a fresh delete handle (#731); the
    // peeked receiptHandle alone goes stale and no-ops the delete.
    messageId: a.string(),
  })
  .returns(a.json())
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(dlqAdmin));
