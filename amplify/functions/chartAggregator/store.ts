import {
  DynamoDBClient,
  UpdateItemCommand,
  ScanCommand,
  BatchWriteItemCommand,
  type WriteRequest,
  type BatchWriteItemCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { AggregateStore } from './handler';
import { pickStatMessage } from './handler';
import type { CounterOp, StatMessage } from './contributions';

/**
 * Real DynamoDB adapter for the chart aggregator (#780).
 *
 * Reads the Message table (Scan, full recompute) and writes the ChartAggregate
 * table — atomic `ADD` on the incremental path, absolute Put + prune on the
 * recompute path. Raw SDK only (no Amplify Data client) so the Lambda stays out
 * of the data→function dependency edge. Table names arrive via env (wired in
 * backend.ts): `CHART_AGGREGATE_TABLE` + `MESSAGE_TABLE`.
 *
 * Amplify auto-adds non-nullable `createdAt` / `updatedAt` to the model and
 * only stamps them on AppSync writes — a raw SDK write must set them itself or
 * every later `listChartAggregates` fails on the non-nullable AWSDateTime
 * (#649). So every write stamps `updatedAt` + `computedAt` and seeds
 * `createdAt` via `if_not_exists`.
 */

let cachedClient: DynamoDBClient | undefined;
function client(): DynamoDBClient {
  if (!cachedClient) cachedClient = new DynamoDBClient({});
  return cachedClient;
}

function chartTable(): string {
  const t = process.env.CHART_AGGREGATE_TABLE;
  if (!t) throw new Error('chartAggregator: CHART_AGGREGATE_TABLE env not set');
  return t;
}
function messageTable(): string {
  const t = process.env.MESSAGE_TABLE;
  if (!t) throw new Error('chartAggregator: MESSAGE_TABLE env not set');
  return t;
}

/**
 * Apply counter deltas with a caller-supplied client + table — atomic
 * `UpdateItem ADD` per op. Shared so the inline path in `messageMutations`
 * (event-driven, on the real Message write resolvers) and the aggregator's
 * own store use one code path. Concurrency-safe (ADD is atomic), so two
 * concurrent writers never lose an increment.
 */
export async function applyDeltasWith(
  ddb: DynamoDBClient,
  table: string,
  ops: CounterOp[],
  nowIso: string,
): Promise<void> {
  await Promise.all(
    ops.map((op) =>
      ddb.send(
        new UpdateItemCommand({
          TableName: table,
          Key: marshall({ metric: op.metric, dimension: op.dimension }),
          UpdateExpression:
            'ADD #count :delta SET #updatedAt = :now, #computedAt = :now, #createdAt = if_not_exists(#createdAt, :now)',
          ExpressionAttributeNames: {
            '#count': 'count',
            '#updatedAt': 'updatedAt',
            '#computedAt': 'computedAt',
            '#createdAt': 'createdAt',
          },
          ExpressionAttributeValues: marshall({ ':delta': op.delta, ':now': nowIso }),
        }),
      ),
    ),
  );
}

async function applyDeltas(ops: CounterOp[], nowIso: string): Promise<void> {
  await applyDeltasWith(client(), chartTable(), ops, nowIso);
}

async function scanMessages(): Promise<StatMessage[]> {
  const table = messageTable();
  const out: StatMessage[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await client().send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey: lastKey as never,
        ProjectionExpression:
          '#type, body, sender, receiver, broadcastTs, deletedAt, flaggedForReview, publishedAt',
        ExpressionAttributeNames: { '#type': 'type' },
      }),
    );
    for (const item of res.Items ?? []) {
      const m = pickStatMessage(unmarshall(item));
      if (m) out.push(m);
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/** Existing (metric, dimension) keys in the aggregate table. */
async function scanExistingKeys(table: string): Promise<{ metric: string; dimension: string }[]> {
  const keys: { metric: string; dimension: string }[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await client().send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: 'metric, dimension',
        ExclusiveStartKey: lastKey as never,
      }),
    );
    for (const item of res.Items ?? []) {
      const u = unmarshall(item);
      if (typeof u.metric === 'string' && typeof u.dimension === 'string') {
        keys.push({ metric: u.metric, dimension: u.dimension });
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return keys;
}

async function batchWrite(table: string, requests: WriteRequest[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: WriteRequest[] | undefined = requests.slice(i, i + 25);
    let attempt = 0;
    while (pending && pending.length > 0) {
      const res: BatchWriteItemCommandOutput = await client().send(
        new BatchWriteItemCommand({ RequestItems: { [table]: pending } }),
      );
      pending = res.UnprocessedItems?.[table];
      if (!pending || pending.length === 0) break;
      attempt += 1;
      if (attempt >= 3) {
        throw new Error(
          `chartAggregator: BatchWriteItem left ${pending.length} unprocessed rows after 3 retries`,
        );
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
  }
}

async function writeAbsolute(
  totals: Map<string, { metric: string; dimension: string; count: number }>,
  nowIso: string,
): Promise<void> {
  const table = chartTable();
  const wanted = new Set([...totals.values()].map((t) => `${t.metric}#${t.dimension}`));

  const puts: WriteRequest[] = [...totals.values()].map((t) => ({
    PutRequest: {
      Item: marshall(
        {
          metric: t.metric,
          dimension: t.dimension,
          count: t.count,
          computedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        { removeUndefinedValues: true },
      ),
    },
  }));

  // Prune rows that no longer have any contribution (e.g. a codeword whose only
  // message was deleted) so the recompute is an exact snapshot.
  const existing = await scanExistingKeys(table);
  const deletes: WriteRequest[] = existing
    .filter((k) => !wanted.has(`${k.metric}#${k.dimension}`))
    .map((k) => ({
      DeleteRequest: { Key: marshall({ metric: k.metric, dimension: k.dimension }) },
    }));

  await batchWrite(table, [...puts, ...deletes]);
}

export function createDynamoStore(): AggregateStore {
  return { applyDeltas, scanMessages, writeAbsolute };
}
