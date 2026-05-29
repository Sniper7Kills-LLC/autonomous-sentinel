import type { DynamoDBStreamHandler } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { audit, type AuditDataClient } from '../../data/audit-log-helper';
import {
  buildReprocessMessage,
  ReprocessReason,
  selectForReprocess,
  type ReprocessCandidate,
  type ReprocessMessage,
} from '../linguistic/reprocess';
import {
  parseConfigStreamRecord,
  type LinguisticConfigImage,
  type ParsedConfigChange,
} from './parse';

/**
 * LinguisticConfig DynamoDB-stream consumer (#481).
 *
 * Two behaviours, both keyed off the stream so they stay decoupled
 * from the admin mutation that wrote the row:
 *
 *   (a) Audit-on-update — every INSERT / MODIFY / REMOVE on the
 *       LinguisticConfig table emits a `LINGUISTIC_CONFIG_UPDATE`
 *       AuditLog row with a before/after diff, attributed to the
 *       row's `createdById` (the stream carries no AppSync identity).
 *
 *   (b) Reprocess-on-bump — when a `*_PROMPT_VERSION` key's version
 *       increases, scan Recordings flagged `transcriptionFailed=true`,
 *       filter to the ones the new prompt could actually help
 *       (`selectForReprocess` — never re-runs a previously-successful
 *       Recording), and enqueue one reprocess message each onto the
 *       dedicated reprocess queue. The consumer that actually re-runs
 *       the linguistic step lands with #460; this handler only owns
 *       selection + enqueue (the issue's acceptance criteria).
 *
 * Idempotency: the stream may redeliver. Re-emitting an audit row is
 * tolerable (append-only log). Re-enqueuing a reprocess message is
 * safe because `selectForReprocess` skips any Recording with a prior
 * success, and the eventual consumer's `attempts.ts` dedup short-
 * circuits a repeat `(provider, version, hash)`.
 */

/** Page cap per Recording.list call — keeps a single invocation bounded. */
const SCAN_PAGE_LIMIT = 200;

export interface ConfigStreamDataClient extends AuditDataClient {
  models: AuditDataClient['models'] & {
    Recording: {
      list: (input: {
        filter: {
          transcriptionFailed: { eq: boolean };
          deletedAt: { attributeExists: boolean };
        };
        limit?: number;
        nextToken?: string | null;
      }) => Promise<{
        data: Array<{
          id: string;
          transcriptionFailed?: boolean | null;
          deletedAt?: string | null;
          linguisticAttempts?: unknown;
        }> | null;
        nextToken?: string | null;
        errors?: unknown;
      }>;
    };
  };
}

export interface ConfigStreamDeps {
  dataClient?: ConfigStreamDataClient;
  /** Sends the built reprocess messages to SQS. Injected in tests. */
  sendReprocess?: (messages: ReprocessMessage[]) => Promise<void>;
  now?: () => Date;
  reprocessQueueUrl?: string;
}

let injected: ConfigStreamDeps = {};

export function __setDeps(deps: ConfigStreamDeps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedDataClient: ConfigStreamDataClient | undefined;
async function getDataClient(): Promise<ConfigStreamDataClient> {
  if (injected.dataClient) return injected.dataClient;
  if (cachedDataClient) return cachedDataClient;
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedDataClient = mod.generateClient({ authMode: 'iam' }) as unknown as ConfigStreamDataClient;
  return cachedDataClient;
}

/** Default SQS sender — batches messages 10 at a time (the API cap). */
async function defaultSendReprocess(messages: ReprocessMessage[], queueUrl: string): Promise<void> {
  if (messages.length === 0) return;
  const { SQSClient, SendMessageBatchCommand } = await import('@aws-sdk/client-sqs');
  const sqs = new SQSClient({});
  for (let i = 0; i < messages.length; i += 10) {
    const batch = messages.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((m, j) => ({
          Id: String(i + j),
          MessageBody: JSON.stringify(m),
        })),
      }),
    );
  }
}

function toCandidate(row: {
  id: string;
  transcriptionFailed?: boolean | null;
  deletedAt?: string | null;
  linguisticAttempts?: unknown;
}): ReprocessCandidate {
  return {
    id: row.id,
    deletedAt: row.deletedAt ?? null,
    // The reprocess selector reads `parseFailed`; the Recording model
    // carries the same sentinel as `transcriptionFailed`.
    parseFailed: row.transcriptionFailed ?? null,
    linguisticAttempts: Array.isArray(row.linguisticAttempts)
      ? (row.linguisticAttempts as ReprocessCandidate['linguisticAttempts'])
      : null,
  };
}

/**
 * Scan failed Recordings and build the reprocess messages for a bump.
 * Paginates `Recording.list` to completion.
 */
async function collectReprocessMessages(
  client: ConfigStreamDataClient,
  newPromptVersion: number,
  now: () => Date,
): Promise<ReprocessMessage[]> {
  const messages: ReprocessMessage[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Recording.list({
      filter: {
        transcriptionFailed: { eq: true },
        deletedAt: { attributeExists: false },
      },
      limit: SCAN_PAGE_LIMIT,
      nextToken,
    });
    if (page.errors) {
      throw new Error(
        `linguisticConfigStream: Recording.list errored: ${JSON.stringify(page.errors)}`,
      );
    }
    const candidates = (page.data ?? []).map(toCandidate);
    const selected = selectForReprocess(candidates, newPromptVersion);
    for (const c of selected) {
      messages.push(
        buildReprocessMessage(c.id, ReprocessReason.PROMPT_VERSION_BUMP, newPromptVersion, { now }),
      );
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return messages;
}

/**
 * Audit one config change and, on a prompt-version bump, enqueue the
 * reprocess jobs. Returns the number of reprocess messages enqueued.
 */
export async function processConfigChange(
  parsed: ParsedConfigChange,
  override: ConfigStreamDeps = {},
): Promise<{ enqueued: number }> {
  const deps = { ...injected, ...override };
  const client = deps.dataClient ?? (await getDataClient());
  const now = deps.now ?? (() => new Date());

  // (a) Audit every config change.
  await audit(
    { identity: { sub: parsed.actorId } },
    {
      action: 'LINGUISTIC_CONFIG_UPDATE',
      targetType: 'LinguisticConfig',
      targetId: parsed.key,
      before: parsed.before,
      after: parsed.after,
    },
    { client },
  );

  if (!parsed.isPromptVersionBump || parsed.newPromptVersion === null) {
    return { enqueued: 0 };
  }

  // (b) Reprocess on bump.
  const messages = await collectReprocessMessages(client, parsed.newPromptVersion, now);

  // Record the bump + how much work it will enqueue BEFORE sending, so a
  // transient SQS failure (which the stream redrives) never leaves the
  // bump unaudited. The redrive re-runs the whole record; the duplicate
  // append-only audit rows are tolerable, and the enqueue itself is
  // idempotent (selectForReprocess skips any prior success).
  await audit(
    { identity: { sub: parsed.actorId } },
    {
      action: 'PROMPT_VERSION_BUMP',
      targetType: 'LinguisticConfig',
      targetId: parsed.key,
      before: { promptVersion: parsed.before.promptVersion ?? null },
      after: { promptVersion: parsed.newPromptVersion, reprocessEnqueued: messages.length },
    },
    { client },
  );

  if (messages.length > 0) {
    const send =
      deps.sendReprocess ??
      ((m: ReprocessMessage[]) => {
        const queueUrl = deps.reprocessQueueUrl ?? process.env.REPROCESS_QUEUE_URL;
        if (!queueUrl) {
          throw new Error('linguisticConfigStream: REPROCESS_QUEUE_URL not configured');
        }
        return defaultSendReprocess(m, queueUrl);
      });
    await send(messages);
  }

  return { enqueued: messages.length };
}

function imageToPlain(
  image: Record<string, AttributeValue> | undefined,
): LinguisticConfigImage | undefined {
  if (!image) return undefined;
  return unmarshall(image) as LinguisticConfigImage;
}

export const handler: DynamoDBStreamHandler = async (event, _context, _callback) => {
  for (const record of event.Records) {
    const parsed = parseConfigStreamRecord({
      eventName: record.eventName,
      oldImage: imageToPlain(
        record.dynamodb?.OldImage as Record<string, AttributeValue> | undefined,
      ),
      newImage: imageToPlain(
        record.dynamodb?.NewImage as Record<string, AttributeValue> | undefined,
      ),
    });
    if (!parsed) continue;
    await processConfigChange(parsed);
  }
};
