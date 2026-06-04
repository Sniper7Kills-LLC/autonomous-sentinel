import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  SQSClient,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for the admin DLQ + manual-reprocess
 * view (#107). Dispatches on the resolver field name (top-level
 * `event.fieldName` in prod, `event.info.fieldName` in the typed shape):
 *
 *   - `listDlqMessages` — peek the requested stage's DLQ (visibility
 *     timeout 0, no delete) and return stuck messages with friendly
 *     metadata.
 *   - `requeueDlqMessage` — SendMessage the body onto the stage's
 *     PRIMARY queue, then DeleteMessage it from the DLQ. Audits
 *     `DLQ_REQUEUE`.
 *   - `dropDlqMessage` — DeleteMessage from the DLQ, mark the Recording
 *     terminally `FAILED` when known, audit `DLQ_DROP`.
 *
 * Every operation is admin-only — defense-in-depth behind the
 * schema-level `allow.group('admin')` authz.
 *
 * SQS receipt-handle caveat: handles returned by `listDlqMessages` come
 * from a zero-visibility-timeout peek and go stale as soon as the message
 * is received again (the UI re-polls every 30s). SQS only honours
 * `DeleteMessage` for the most-recently-received handle, so deleting with a
 * peeked handle "succeeds" without removing the message — it reappears
 * (#731). `requeue` / `drop` therefore take a `messageId` and re-receive a
 * fresh handle (`receiveFreshHandle`) immediately before deleting; the
 * peeked `receiptHandle` is only a legacy fallback when no `messageId` is
 * supplied.
 */

export type PipelineStage = 'preprocess' | 'transcribe' | 'linguistic';

const STAGES: readonly PipelineStage[] = ['preprocess', 'transcribe', 'linguistic'];

/** Env var holding the PRIMARY queue URL for a stage. */
const MAIN_QUEUE_ENV: Record<PipelineStage, string> = {
  preprocess: 'PREPROCESS_QUEUE_URL',
  transcribe: 'TRANSCRIBE_QUEUE_URL',
  linguistic: 'LINGUISTIC_QUEUE_URL',
};

/** Env var holding the DLQ URL for a stage. */
const DLQ_QUEUE_ENV: Record<PipelineStage, string> = {
  preprocess: 'PREPROCESS_DLQ_URL',
  transcribe: 'TRANSCRIBE_DLQ_URL',
  linguistic: 'LINGUISTIC_DLQ_URL',
};

/** One stuck DLQ message, shaped for the admin table. */
export interface DlqMessageView {
  stage: PipelineStage;
  messageId: string;
  receiptHandle: string;
  body: string;
  /** Best-effort recordingId parsed out of the message body, when present. */
  recordingId: string | null;
  /** SQS `ApproximateReceiveCount` — how many times delivery was attempted. */
  approximateReceiveCount: number;
  /** ISO 8601 of the SQS `SentTimestamp` (when the message landed on the DLQ). */
  enqueuedAt: string | null;
  /** Best-effort failure reason parsed out of the body, when present. */
  errorReason: string | null;
}

export interface ListDlqMessagesResult {
  stage: PipelineStage;
  messages: DlqMessageView[];
}

export interface RequeueDlqMessageResult {
  status: 'requeued';
}

export interface DropDlqMessageResult {
  status: 'dropped';
}

// --- dependency injection seam (mirrors messageMutations) ---------------

export interface DlqRecordingClient {
  models: {
    Recording: {
      update: (
        input: { id: string } & Record<string, unknown>,
      ) => Promise<{ data: unknown; errors?: unknown }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

interface Deps {
  sqs?: SQSClient;
  dataClient?: DlqRecordingClient;
  audit?: AuditFn;
  now?: () => Date;
}

let injected: Deps = {};

export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedSqs: SQSClient | undefined;
function sqsClient(): SQSClient {
  if (!cachedSqs) cachedSqs = new SQSClient({});
  return cachedSqs;
}

let cachedDataClient: DlqRecordingClient | undefined;
async function getDefaultDataClient(): Promise<DlqRecordingClient> {
  if (cachedDataClient) return cachedDataClient;
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedDataClient = mod.generateClient({ authMode: 'iam' }) as unknown as DlqRecordingClient;
  return cachedDataClient;
}

// --- helpers ------------------------------------------------------------

/**
 * True when an Amplify Data `errors` payload represents a DynamoDB
 * conditional-check failure — i.e. the target row does not exist (Amplify's
 * auto-generated update conditions on `attribute_exists(id)`). Matched on the
 * AppSync `errorType` (`DynamoDB:ConditionalCheckFailedException`) with a
 * message fallback so a transport that only carries the human string still
 * resolves. Used by dropDlqMessage to distinguish "row gone" (proceed) from a
 * transient update failure (keep the message) — #714.
 */
function isConditionalCheckFailed(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    if (!e || typeof e !== 'object') return false;
    const { errorType, message } = e as { errorType?: unknown; message?: unknown };
    // Prefer the AppSync `errorType` (`DynamoDB:ConditionalCheckFailedException`);
    // fall back to the human message for transports that omit errorType. Match
    // only these two fields — not the whole serialised error — so an unrelated
    // field (path/locations) can't false-positive.
    return (
      (typeof errorType === 'string' && errorType.includes('ConditionalCheckFailed')) ||
      (typeof message === 'string' && message.includes('ConditionalCheckFailed'))
    );
  });
}

function isAdmin(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf('admin') >= 0;
}

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function auditContextFrom(event: {
  identity?: unknown;
  request?: { headers?: Record<string, string | undefined> };
}): AuditContext {
  const sub = identitySub(event.identity);
  return {
    identity: sub ? { sub } : null,
    request: { headers: event.request?.headers ?? {} },
  };
}

function parseStage(raw: unknown): PipelineStage {
  if (typeof raw === 'string' && (STAGES as readonly string[]).indexOf(raw) >= 0) {
    return raw as PipelineStage;
  }
  throw new Error(`dlqAdmin: stage must be one of ${STAGES.join(', ')}; got "${String(raw)}"`);
}

function envUrl(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`dlqAdmin: ${key} env var is required`);
  return v;
}

/**
 * Best-effort extraction of a recordingId + error reason from a pipeline
 * message body. Pipeline messages are JSON; we look for the common id
 * field names without locking to one stage's exact shape.
 */
function parseBody(body: string): { recordingId: string | null; errorReason: string | null } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const idCandidate =
      parsed.recordingId ?? parsed.recordingID ?? parsed.id ?? parsed.recording_id;
    const reasonCandidate =
      parsed.errorReason ?? parsed.failedReason ?? parsed.error ?? parsed.reason;
    return {
      recordingId: typeof idCandidate === 'string' && idCandidate.length > 0 ? idCandidate : null,
      errorReason:
        typeof reasonCandidate === 'string' && reasonCandidate.length > 0 ? reasonCandidate : null,
    };
  } catch {
    return { recordingId: null, errorReason: null };
  }
}

/**
 * Re-receive from a DLQ to obtain a CURRENT receipt handle for `messageId`.
 *
 * SQS honours `DeleteMessage` only for the most-recently-received receipt
 * handle of a message; an older handle (e.g. one peeked by `listDlqMessages`
 * with `VisibilityTimeout: 0`, then superseded by the UI's 30s re-poll)
 * makes the delete "succeed" without removing the message — so dropped /
 * requeued messages reappear (#731). Fix: fetch a fresh handle here, then
 * delete with it immediately.
 *
 * SQS can't fetch a specific MessageId, so we page through the queue:
 * incidental non-target messages are received with a short visibility
 * timeout (briefly hidden) so successive rounds advance instead of
 * re-reading the same items. Returns the fresh handle, or `null` when the
 * message isn't on the queue (already actioned / in-flight).
 */
async function receiveFreshHandle(
  sqs: SQSClient,
  queueUrl: string,
  messageId: string,
  maxRounds = 8,
): Promise<string | null> {
  const seen = new Set<string>();
  for (let round = 0; round < maxRounds; round += 1) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        // Briefly hide incidental non-target messages so paging advances;
        // short enough that they return to the queue right after triage.
        VisibilityTimeout: 10,
        WaitTimeSeconds: 1,
        AttributeNames: ['All'],
      }),
    );
    const batch = res.Messages ?? [];
    if (batch.length === 0) break;
    let progressed = false;
    for (const m of batch) {
      if (!m.MessageId || !m.ReceiptHandle) continue;
      if (m.MessageId === messageId) return m.ReceiptHandle;
      if (!seen.has(m.MessageId)) {
        seen.add(m.MessageId);
        progressed = true;
      }
    }
    // Only re-seeing already-known messages → the queue is exhausted of
    // anything new; the target isn't here.
    if (!progressed) break;
  }
  return null;
}

// --- dispatch handlers --------------------------------------------------

async function dispatchList(
  event: { arguments: Record<string, unknown>; identity?: unknown },
  deps: { sqs: SQSClient },
): Promise<ListDlqMessagesResult> {
  if (!isAdmin(event.identity)) {
    throw new Error('listDlqMessages: caller is not in the admin group');
  }
  const stage = parseStage(event.arguments.stage);
  const queueUrl = envUrl(DLQ_QUEUE_ENV[stage]);

  // Peek loop: SQS ReceiveMessage returns a sample (≤10) per call. Poll
  // a few rounds with VisibilityTimeout 0 (no hiding) and dedupe by
  // MessageId to surface as many stuck items as a low-volume DLQ holds
  // without claiming them. Bounded at 3 rounds so a large DLQ can't make
  // this resolver run long — the count cap is logged below.
  const byId = new Map<string, DlqMessageView>();
  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const res = await deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 0,
        WaitTimeSeconds: 0,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    const batch = res.Messages ?? [];
    if (batch.length === 0) break;
    for (const m of batch) {
      if (!m.MessageId || !m.ReceiptHandle) continue;
      if (byId.has(m.MessageId)) continue;
      const body = m.Body ?? '';
      const { recordingId, errorReason } = parseBody(body);
      const sentTs = m.Attributes?.SentTimestamp;
      const receiveCount = m.Attributes?.ApproximateReceiveCount;
      byId.set(m.MessageId, {
        stage,
        messageId: m.MessageId,
        receiptHandle: m.ReceiptHandle,
        body,
        recordingId,
        approximateReceiveCount: receiveCount ? Number(receiveCount) : 0,
        enqueuedAt: sentTs ? new Date(Number(sentTs)).toISOString() : null,
        errorReason,
      });
    }
  }
  return { stage, messages: Array.from(byId.values()) };
}

async function dispatchRequeue(
  event: {
    arguments: Record<string, unknown>;
    identity?: unknown;
    request?: { headers?: Record<string, string | undefined> };
  },
  deps: { sqs: SQSClient; audit: AuditFn },
): Promise<RequeueDlqMessageResult> {
  if (!isAdmin(event.identity)) {
    throw new Error('requeueDlqMessage: caller is not in the admin group');
  }
  const stage = parseStage(event.arguments.stage);
  const receiptHandle = event.arguments.receiptHandle;
  const body = event.arguments.body;
  if (typeof receiptHandle !== 'string' || receiptHandle.length === 0) {
    throw new Error('requeueDlqMessage: receiptHandle argument is required');
  }
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('requeueDlqMessage: body argument is required');
  }
  const recordingId =
    typeof event.arguments.recordingId === 'string' ? event.arguments.recordingId : null;
  const messageId =
    typeof event.arguments.messageId === 'string' ? event.arguments.messageId : null;

  const mainUrl = envUrl(MAIN_QUEUE_ENV[stage]);
  const dlqUrl = envUrl(DLQ_QUEUE_ENV[stage]);

  // Resolve the receipt handle to delete with. Prefer a freshly re-received
  // handle keyed off messageId — the UI-supplied handle is a stale peek and
  // would make the DeleteMessage a silent no-op (#731). If the message is no
  // longer on the DLQ, abort BEFORE sending to the primary queue so we never
  // half-requeue (send-without-delete = duplicate redrive).
  let deleteHandle = receiptHandle;
  if (messageId) {
    const fresh = await receiveFreshHandle(deps.sqs, dlqUrl, messageId);
    if (!fresh) {
      throw new Error(
        `requeueDlqMessage: message ${messageId} is no longer on the DLQ (already actioned)`,
      );
    }
    deleteHandle = fresh;
  }

  // Send back onto the primary queue FIRST, then remove from the DLQ.
  // If the delete fails the message is still on the DLQ (will redrive
  // again) — at-least-once, never a silent loss.
  await deps.sqs.send(new SendMessageCommand({ QueueUrl: mainUrl, MessageBody: body }));
  await deps.sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: deleteHandle }));

  await deps.audit(auditContextFrom(event), {
    action: 'DLQ_REQUEUE',
    targetType: 'Recording',
    targetId: recordingId ?? `dlq:${stage}`,
    reason: `Requeued stuck ${stage} message to primary queue`,
  });

  return { status: 'requeued' };
}

async function dispatchDrop(
  event: {
    arguments: Record<string, unknown>;
    identity?: unknown;
    request?: { headers?: Record<string, string | undefined> };
  },
  deps: {
    sqs: SQSClient;
    getClient: () => Promise<DlqRecordingClient>;
    audit: AuditFn;
    now: () => Date;
  },
): Promise<DropDlqMessageResult> {
  if (!isAdmin(event.identity)) {
    throw new Error('dropDlqMessage: caller is not in the admin group');
  }
  const stage = parseStage(event.arguments.stage);
  const receiptHandle = event.arguments.receiptHandle;
  if (typeof receiptHandle !== 'string' || receiptHandle.length === 0) {
    throw new Error('dropDlqMessage: receiptHandle argument is required');
  }
  const recordingId =
    typeof event.arguments.recordingId === 'string' ? event.arguments.recordingId : null;
  const reason = typeof event.arguments.reason === 'string' ? event.arguments.reason : null;
  const messageId =
    typeof event.arguments.messageId === 'string' ? event.arguments.messageId : null;

  // Mark the Recording terminally FAILED FIRST, then delete from the DLQ.
  // Ordering matters for failure safety: a TRANSIENT Recording.update error
  // rethrows so the message stays on the DLQ (nothing lost — the admin can
  // re-drop). A MISSING row is the exception: Amplify's auto-update conditions
  // on `attribute_exists(id)`, so a recordingId that no longer exists (deleted)
  // or never existed (the failed message's stage hadn't created a Recording,
  // or the body's id isn't a real Recording id) throws
  // ConditionalCheckFailedException. There is then no Recording to leave
  // un-FAILED, so we log + proceed with the drop rather than wedging the
  // message on the DLQ forever (#714).
  if (recordingId) {
    const client = await deps.getClient();
    const now = deps.now().toISOString();
    const updated = await client.models.Recording.update({
      id: recordingId,
      transcriptionStatus: 'FAILED',
      transcriptionFailed: true,
      transcriptionStatusUpdatedAt: now,
      failedReason: reason ?? `Dropped from ${stage} DLQ by admin`,
    });
    if (updated.errors) {
      if (isConditionalCheckFailed(updated.errors)) {
        console.warn(
          'dropDlqMessage: Recording row not found (deleted / never created); dropping the DLQ message anyway',
          { recordingId, stage },
        );
      } else {
        throw new Error(
          `dropDlqMessage: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
        );
      }
    }
  }

  const dlqUrl = envUrl(DLQ_QUEUE_ENV[stage]);
  // Prefer a freshly re-received handle (the UI-supplied one is a stale peek
  // and would make DeleteMessage a silent no-op → the message reappears,
  // #731). When messageId resolves to nothing, the message is already off the
  // DLQ — record the drop intent without a redundant delete.
  if (messageId) {
    const fresh = await receiveFreshHandle(deps.sqs, dlqUrl, messageId);
    if (fresh) {
      await deps.sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: fresh }));
    } else {
      console.warn('dropDlqMessage: message already gone from the DLQ; nothing to delete', {
        messageId,
        stage,
      });
    }
  } else {
    await deps.sqs.send(
      new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: receiptHandle }),
    );
  }

  await deps.audit(auditContextFrom(event), {
    action: 'DLQ_DROP',
    targetType: 'Recording',
    targetId: recordingId ?? `dlq:${stage}`,
    reason: reason ?? `Dropped stuck ${stage} message from DLQ`,
  });

  return { status: 'dropped' };
}

// --- entry point --------------------------------------------------------

// `_context` / `_callback` declared (unused) so the 3-arg Lambda Handler
// call sites in tests aren't flagged by CodeQL (js/superfluous-trailing-arguments).
export const handler: AppSyncResolverHandler<
  Record<string, unknown>,
  ListDlqMessagesResult | RequeueDlqMessageResult | DropDlqMessageResult
> = async (event, _context, _callback) => {
  const sqs = injected.sqs ?? sqsClient();
  const audit: AuditFn = injected.audit ?? defaultAudit;
  const now = injected.now ?? (() => new Date());
  // AppSync's Lambda-data-source payload carries `fieldName` at the TOP
  // level of the event; the `AppSyncResolverHandler` type only surfaces it
  // under `info.fieldName`, which is what unit-test fixtures mirror. Reading
  // only `event.info?.fieldName` made every real invocation dispatch on
  // `undefined` ("unsupported fieldName undefined", #651 prod regression).
  // Accept both shapes — same fix as transcriptRevisionMutations.
  const fieldName = (event as unknown as { fieldName?: string }).fieldName ?? event.info?.fieldName;

  switch (fieldName) {
    case 'listDlqMessages':
      return dispatchList(event, { sqs });
    case 'requeueDlqMessage':
      return dispatchRequeue(event, { sqs, audit });
    case 'dropDlqMessage': {
      const getClient = async () => injected.dataClient ?? (await getDefaultDataClient());
      return dispatchDrop(event, { sqs, getClient, audit, now });
    }
    default:
      throw new Error(`dlqAdmin: unsupported fieldName "${String(fieldName)}"`);
  }
};
