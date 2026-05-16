import type { Handler, ScheduledEvent } from 'aws-lambda';
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  ScanCommand,
  type AttributeValue,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * `fieldVoteOrphanJanitor` — daily/weekly EventBridge cron that
 * sweeps FieldVote rows whose `messageId` no longer resolves to an
 * existing Message (#270).
 *
 * Why this exists:
 *   `castFieldVote` does not Pre-check `messageId` existence before
 *   the row upsert (see PR #268 review). Orphan votes are inert — the
 *   public aggregate-count query joins on `Message.id`, so an orphan
 *   never surfaces in any UI — but they consume DDB storage. This
 *   janitor is the cleanup path.
 *
 * Strategy:
 *   1. Scan FieldVote in pages (DDB max page ≈ 1MB).
 *   2. Per page, BatchGetItem on Message for the page's messageIds.
 *   3. Identify messageIds that don't resolve → those FieldVote rows
 *      are orphans.
 *   4. BatchWriteItem Delete the orphan rows in chunks of 25.
 *   5. Emit one `FIELDVOTE_ORPHAN_SWEEP` audit entry at the end with
 *      the total orphan count + sample messageIds for observability.
 *
 * Failures on a single page (e.g. DDB throttle on BatchGetItem) log +
 * continue to the next page. The Lambda's outer retry / DLQ catches
 * a wholesale failure.
 */

export type FieldVoteRow = {
  fieldKey: string;
  messageId: string;
  [k: string]: unknown;
};

export interface ScanPage {
  items: FieldVoteRow[];
  nextToken?: string;
}

export interface BatchGetResult {
  /** Subset of input.messageIds that exist as Message rows. */
  presentIds: Set<string>;
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

export interface JanitorDeps {
  scanFieldVotes: (input: { nextToken?: string }) => Promise<ScanPage>;
  batchGetMessages: (input: { messageIds: string[] }) => Promise<BatchGetResult>;
  deleteFieldVotes: (input: { fieldKeys: string[] }) => Promise<void>;
  audit: AuditFn;
  now: () => Date;
  /** Max delete-keys per BatchWriteItem call. Default 25 (DDB limit). */
  batchSize?: number;
}

let injected: Partial<JanitorDeps> = {};

export function __setDeps(deps: Partial<JanitorDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

function defaultFieldVoteTableName(): string {
  const v = process.env.FIELD_VOTE_TABLE_NAME;
  if (!v) {
    throw new Error('fieldVoteOrphanJanitor: FIELD_VOTE_TABLE_NAME env var is required');
  }
  return v;
}

function defaultMessageTableName(): string {
  const v = process.env.MESSAGE_TABLE_NAME;
  if (!v) {
    throw new Error('fieldVoteOrphanJanitor: MESSAGE_TABLE_NAME env var is required');
  }
  return v;
}

/**
 * Production scanner. Pages through FieldVote with ProjectionExpression
 * limited to `fieldKey` + `messageId` so the orphan check doesn't drag
 * the rest of the row over the wire on every page.
 */
async function defaultScanFieldVotes(input: { nextToken?: string }): Promise<ScanPage> {
  const exclusiveStartKey: Record<string, AttributeValue> | undefined = input.nextToken
    ? (JSON.parse(input.nextToken) as Record<string, AttributeValue>)
    : undefined;
  const res: ScanCommandOutput = await getDdbClient().send(
    new ScanCommand({
      TableName: defaultFieldVoteTableName(),
      ProjectionExpression: '#fk, #mid',
      ExpressionAttributeNames: { '#fk': 'fieldKey', '#mid': 'messageId' },
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );
  const items: FieldVoteRow[] = [];
  if (res.Items) {
    for (const raw of res.Items) {
      items.push(unmarshall(raw) as FieldVoteRow);
    }
  }
  return {
    items,
    nextToken: res.LastEvaluatedKey ? JSON.stringify(res.LastEvaluatedKey) : undefined,
  };
}

async function defaultBatchGetMessages(input: { messageIds: string[] }): Promise<BatchGetResult> {
  const presentIds = new Set<string>();
  if (input.messageIds.length === 0) return { presentIds };
  const tableName = defaultMessageTableName();
  // BatchGetItem caps at 100 keys per call.
  for (let i = 0; i < input.messageIds.length; i += 100) {
    const chunk = input.messageIds.slice(i, i + 100);
    const res = await getDdbClient().send(
      new BatchGetItemCommand({
        RequestItems: {
          [tableName]: {
            Keys: chunk.map((id) => marshall({ id })),
            ProjectionExpression: 'id',
          },
        },
      }),
    );
    const rows = res.Responses?.[tableName] ?? [];
    for (const raw of rows) {
      const row = unmarshall(raw) as { id?: string };
      if (typeof row.id === 'string') {
        presentIds.add(row.id);
      }
    }
  }
  return { presentIds };
}

async function defaultDeleteFieldVotes(input: { fieldKeys: string[] }): Promise<void> {
  if (input.fieldKeys.length === 0) return;
  const tableName = defaultFieldVoteTableName();
  // BatchWriteItem caps at 25 ops per call — handler already chunks
  // before calling us, but enforce defensively in case batchSize is
  // overridden upstream.
  for (let i = 0; i < input.fieldKeys.length; i += 25) {
    const chunk = input.fieldKeys.slice(i, i + 25);
    await getDdbClient().send(
      new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: chunk.map((fieldKey) => ({
            DeleteRequest: {
              Key: marshall({ fieldKey }),
            },
          })),
        },
      }),
    );
  }
}

function resolveDeps(): JanitorDeps {
  return {
    scanFieldVotes: injected.scanFieldVotes ?? defaultScanFieldVotes,
    batchGetMessages: injected.batchGetMessages ?? defaultBatchGetMessages,
    deleteFieldVotes: injected.deleteFieldVotes ?? defaultDeleteFieldVotes,
    audit: injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts)),
    now: injected.now ?? (() => new Date()),
    batchSize: injected.batchSize,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export const handler: Handler<ScheduledEvent, void> = async () => {
  const deps = resolveDeps();
  const batchSize = deps.batchSize ?? 25;

  const orphanFieldKeys: string[] = [];
  const orphanMessageIds: string[] = [];
  let nextToken: string | undefined;

  do {
    const page = await deps.scanFieldVotes({ nextToken });
    nextToken = page.nextToken;
    if (page.items.length === 0) continue;

    const distinctMessageIds = Array.from(new Set(page.items.map((r) => r.messageId)));
    let presentIds: Set<string>;
    try {
      const got = await deps.batchGetMessages({ messageIds: distinctMessageIds });
      presentIds = got.presentIds;
    } catch (err) {
      console.error('fieldVoteOrphanJanitor: batch-get failed; skipping page', {
        firstMessageId: distinctMessageIds[0],
        pageSize: page.items.length,
        err,
      });
      continue;
    }

    for (const row of page.items) {
      if (!presentIds.has(row.messageId)) {
        orphanFieldKeys.push(row.fieldKey);
        orphanMessageIds.push(row.messageId);
      }
    }
  } while (nextToken);

  for (const batch of chunk(orphanFieldKeys, batchSize)) {
    await deps.deleteFieldVotes({ fieldKeys: batch });
  }

  await deps.audit(
    { identity: null, request: { headers: {} } },
    {
      action: 'FIELDVOTE_ORPHAN_SWEEP',
      targetType: 'FieldVote',
      targetId: 'sweep',
      after: {
        orphanCount: orphanFieldKeys.length,
        firstMessageId: orphanMessageIds[0] ?? null,
        lastMessageId: orphanMessageIds[orphanMessageIds.length - 1] ?? null,
        sweptAt: deps.now().toISOString(),
      },
    },
  );

  console.info('fieldVoteOrphanJanitor: sweep complete', {
    orphanCount: orphanFieldKeys.length,
  });
};
