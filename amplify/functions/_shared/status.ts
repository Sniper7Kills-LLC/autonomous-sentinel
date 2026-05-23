import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

/**
 * Shared pipeline-status helper for every consumer Lambda (#69).
 *
 * Every Lambda in the recording → preprocess → transcribe →
 * linguistic chain calls `setStatus(recordingId, status, opts?)`
 * at entry, exit, and failure paths. The helper does a single
 * conditional `UpdateItem` against the Recording row:
 *
 *   - `transcriptionStatus` set to the new state.
 *   - `transcriptionStatusUpdatedAt` set to the call timestamp,
 *     which is what the AppSync `onUpdateRecording` subscription
 *     (#70) fires off of.
 *   - `failedReason` set on `*_FAILED` / `FAILED` transitions only
 *     (human-readable triage hint for the admin DLQ + reprocess
 *     UI).
 *   - `transcriptionFailed` boolean flipped to `true` on any
 *     failure-flavoured status so existing read paths that
 *     branch on that field (e.g. the `submitTranscriptRevision`
 *     gate) keep working.
 *
 * The update is idempotent on retry: a `ConditionExpression`
 * guards against regressing a more-advanced status (PUBLISHED
 * never re-enters PARSING) but allows the same-status no-op write
 * so duplicate event deliveries don't fail loudly.
 *
 * Status ordering (lower = earlier):
 *   1. QUEUED
 *   2. PREPROCESSING
 *   3. PREPROCESS_FAILED      ← failure terminal
 *   4. TRANSCRIBING
 *   5. TRANSCRIBE_FAILED      ← failure terminal
 *   6. PARSING
 *   7. PARSE_FAILED           ← failure terminal
 *   8. PUBLISHED              ← happy-path terminal
 *   9. FAILED                 ← catch-all terminal
 *
 * The helper's `ConditionExpression` checks that the existing
 * status is NOT one of the terminal states unless the incoming
 * status equals it (idempotent retry). A consumer Lambda that
 * tries to advance a row already at `PUBLISHED` is a bug; this
 * helper turns it into a no-op rather than a corruption.
 *
 * Production / sandbox use this helper via the lazy-cached
 * DDB client. Tests inject a stub via `__setDeps({ client })`.
 *
 * Required env var: `RECORDING_TABLE_NAME`. Wired by backend.ts
 * on each consumer Lambda's `addEnvironment(...)` call when that
 * Lambda lands.
 */

export type TranscriptionStatus =
  | 'QUEUED'
  | 'PREPROCESSING'
  | 'PREPROCESS_FAILED'
  | 'TRANSCRIBING'
  | 'TRANSCRIBE_FAILED'
  | 'PARSING'
  | 'PARSE_FAILED'
  | 'PUBLISHED'
  | 'FAILED';

export const TERMINAL_STATUSES: ReadonlySet<TranscriptionStatus> = new Set([
  'PREPROCESS_FAILED',
  'TRANSCRIBE_FAILED',
  'PARSE_FAILED',
  'PUBLISHED',
  'FAILED',
]);

const FAILURE_STATUSES: ReadonlySet<TranscriptionStatus> = new Set([
  'PREPROCESS_FAILED',
  'TRANSCRIBE_FAILED',
  'PARSE_FAILED',
  'FAILED',
]);

export function isFailure(status: TranscriptionStatus): boolean {
  return FAILURE_STATUSES.has(status);
}

export interface SetStatusOpts {
  /**
   * Free-text triage hint captured on `transcriptionStatusUpdatedAt`-
   * adjacent `failedReason` column. Truncated client-side to 1 KB so
   * an upstream stack-trace dump doesn't blow up the DDB row.
   */
  failedReason?: string;
  /**
   * Test seam — overrides the wall-clock timestamp so vitest can
   * pin `transcriptionStatusUpdatedAt` without freezing system time.
   */
  now?: () => Date;
}

export interface StatusDeps {
  client?: { send: (cmd: UpdateItemCommand) => Promise<unknown> };
  tableName?: string;
}

let injected: StatusDeps = {};
let cachedClient: DynamoDBClient | undefined;

export function __setStatusDeps(deps: StatusDeps): void {
  injected = deps;
}

export function __resetStatusDeps(): void {
  injected = {};
}

function getClient(): { send: (cmd: UpdateItemCommand) => Promise<unknown> } {
  if (injected.client) return injected.client;
  if (!cachedClient) cachedClient = new DynamoDBClient({});
  return cachedClient;
}

function getTableName(): string {
  const fromEnv = injected.tableName ?? process.env.RECORDING_TABLE_NAME;
  if (!fromEnv) {
    throw new Error('status helper: RECORDING_TABLE_NAME env var is required');
  }
  return fromEnv;
}

const MAX_FAILED_REASON_LEN = 1024;

export async function setStatus(
  recordingId: string,
  status: TranscriptionStatus,
  opts: SetStatusOpts = {},
): Promise<void> {
  if (!recordingId || recordingId.trim() === '') {
    throw new Error('setStatus: recordingId is required');
  }

  const now = (opts.now ?? (() => new Date()))().toISOString();
  const client = getClient();
  const tableName = getTableName();

  // ConditionExpression — block regression from a more-advanced
  // terminal state. Allow the same-state idempotent re-write so
  // duplicate SQS deliveries don't fail.
  //
  // The expression reads: "the current status either does not
  // exist (fresh row, shouldn't happen but defensive), or equals
  // the incoming status (idempotent retry), or is NOT in the
  // terminal set". `attribute_not_exists` first because that's
  // the cheapest evaluation.
  const expressionAttributeNames: Record<string, string> = {
    '#status': 'transcriptionStatus',
    '#updatedAt': 'transcriptionStatusUpdatedAt',
    '#failed': 'transcriptionFailed',
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ':status': status,
    ':now': now,
    ':isFailure': isFailure(status),
    ':sameStatus': status,
  };
  const terminalValues = [
    'PUBLISHED',
    'PREPROCESS_FAILED',
    'TRANSCRIBE_FAILED',
    'PARSE_FAILED',
    'FAILED',
  ];
  terminalValues.forEach((v, i) => {
    expressionAttributeValues[`:term${i}`] = v;
  });

  let updateExpression = 'SET #status = :status, #updatedAt = :now, #failed = :isFailure';

  if (opts.failedReason !== undefined) {
    expressionAttributeNames['#failedReason'] = 'failedReason';
    expressionAttributeValues[':failedReason'] = opts.failedReason.slice(0, MAX_FAILED_REASON_LEN);
    updateExpression += ', #failedReason = :failedReason';
  }

  const terminalCheck = terminalValues.map((_, i) => `#status <> :term${i}`).join(' AND ');
  const conditionExpression = `attribute_not_exists(#status) OR #status = :sameStatus OR (${terminalCheck})`;

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: marshall({ id: recordingId }),
        UpdateExpression: updateExpression,
        ConditionExpression: conditionExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues, {
          removeUndefinedValues: true,
        }),
      }),
    );
  } catch (err) {
    // ConditionalCheckFailedException is the documented signal that
    // the row is already at a terminal status that ranks above the
    // incoming one (e.g. trying to advance a PUBLISHED row back to
    // PARSING). Swallow + log; that's the helper doing its job, not
    // a real error.
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      console.info('setStatus: condition check failed (row already at terminal status); no-op', {
        recordingId,
        attemptedStatus: status,
      });
      return;
    }
    throw err;
  }
}
