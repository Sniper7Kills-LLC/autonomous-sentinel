/**
 * Production-side fan-out helpers — shared between the per-signup
 * `legacyClaimWorker` (#272 / #273) and the daily replay
 * `legacyClaimReplaySweeper` (#274).
 *
 * Both Lambdas run the same `fanOutLegacyFks` helper under the hood;
 * the only difference is how they decide *which* claims to fan out
 * (postConfirmation-driven vs. cron-driven). They share the DDB SDK
 * wrappers + the env-var-driven table-name resolver here so the wiring
 * stays in one place.
 *
 * Test-only paths still inject deps directly into the helper; nothing
 * in this module touches injected deps.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type QueryCommandOutput,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  DdbItem,
  FanOutQueryInput,
  FanOutQueryResult,
  FanOutTableNames,
  TransactWriteOp,
} from './fan-out-legacy-fks';

let cachedDdb: DynamoDBClient | undefined;

export function getDdbClient(): DynamoDBClient {
  if (!cachedDdb) cachedDdb = new DynamoDBClient({});
  return cachedDdb;
}

/**
 * Build a per-table name map from env vars. The user table name comes
 * in as a parameter (the User table flows through `USER_TABLE_NAME`,
 * which both worker + sweeper read separately).
 */
export function defaultFanOutTableNames(userTableName: string): FanOutTableNames {
  const fromEnv = (envKey: string): string => {
    const v = process.env[envKey];
    if (!v) {
      throw new Error(`fan-out-production: ${envKey} env var is required`);
    }
    return v;
  };
  return {
    Sdr: fromEnv('SDR_TABLE_NAME'),
    Comment: fromEnv('COMMENT_TABLE_NAME'),
    AbuseReport: fromEnv('ABUSE_REPORT_TABLE_NAME'),
    Donation: fromEnv('DONATION_TABLE_NAME'),
    Recording: fromEnv('RECORDING_TABLE_NAME'),
    TranscriptRevision: fromEnv('TRANSCRIPT_REVISION_TABLE_NAME'),
    User: userTableName,
    FieldVote: fromEnv('FIELD_VOTE_TABLE_NAME'),
    RevisionVote: fromEnv('REVISION_VOTE_TABLE_NAME'),
    Reputation: fromEnv('REPUTATION_TABLE_NAME'),
    NotificationPreference: fromEnv('NOTIFICATION_PREFERENCE_TABLE_NAME'),
  };
}

/**
 * Production fan-out query. Reads either a GSI by `fkColumn = fkValue`
 * (shape 1 + 2 tables) or a base-table GetItem when the input's
 * `indexName === '__pk__'` (shape 3 — PK == userId).
 */
export async function defaultFanOutQuery(input: FanOutQueryInput): Promise<FanOutQueryResult> {
  if (input.indexName === '__pk__') {
    const res = await getDdbClient().send(
      new GetItemCommand({
        TableName: input.tableName,
        Key: marshall({ [input.fkColumn]: input.fkValue }),
      }),
    );
    return res.Item ? { items: [unmarshall(res.Item)] } : { items: [] };
  }
  const items: DdbItem[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
  do {
    const res: QueryCommandOutput = await getDdbClient().send(
      new QueryCommand({
        TableName: input.tableName,
        IndexName: input.indexName,
        KeyConditionExpression: '#fk = :fk',
        ExpressionAttributeNames: { '#fk': input.fkColumn },
        ExpressionAttributeValues: marshall({ ':fk': input.fkValue }),
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (res.Items) {
      for (const raw of res.Items) {
        items.push(unmarshall(raw));
      }
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return { items };
}

/**
 * Production fan-out transactor. Translates the helper's abstract op
 * list into a single `TransactWriteItems` call (≤25 items, enforced
 * by the helper's `batchSize`). All ops run atomically per batch.
 */
export async function defaultFanOutTransact(ops: TransactWriteOp[]): Promise<void> {
  if (ops.length === 0) return;
  const items: TransactWriteItem[] = ops.map((op) => {
    if (op.kind === 'Update') {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const setClauses: string[] = [];
      let i = 0;
      for (const [col, val] of Object.entries(op.set)) {
        const n = `#c${i}`;
        const v = `:v${i}`;
        names[n] = col;
        values[v] = val;
        setClauses.push(`${n} = ${v}`);
        i += 1;
      }
      return {
        Update: {
          TableName: op.tableName,
          Key: marshall(op.key),
          UpdateExpression: `SET ${setClauses.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(values, { removeUndefinedValues: true }),
        },
      };
    }
    if (op.kind === 'Delete') {
      return {
        Delete: {
          TableName: op.tableName,
          Key: marshall(op.key),
        },
      };
    }
    return {
      Put: {
        TableName: op.tableName,
        Item: marshall(op.row, { removeUndefinedValues: true }),
      },
    };
  });
  await getDdbClient().send(new TransactWriteItemsCommand({ TransactItems: items }));
}
