import { DynamoDBClient, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { LinguisticRule, RuleLoader } from './rules-engine';

/**
 * Production `RuleLoader` adapter — Scans the `LinguisticRule` DDB
 * table once per engine cold-load (or TTL expiry), maps the rows to
 * the engine's row shape, and returns them. The engine filters
 * `enabled=true` + sorts by priority itself.
 *
 * Why Scan: the table is bounded by what admins hand-curate (dozens
 * of rules tops). A Scan with `Limit` headroom is cheaper to operate
 * than maintaining a sparse GSI on `enabled`. Switch when the corpus
 * ever outgrows single-page Scans.
 *
 * `LINGUISTIC_RULE_TABLE_NAME` env var wires the table arn at synth
 * time (set by `backend.ts` once the linguistic Lambda lands as a
 * full consumer + this loader is invoked — out of scope for the
 * engine-only PR).
 *
 * The loader returns `LinguisticRule` shapes; bad rows (missing
 * required columns) are filtered out + logged at warn level rather
 * than throwing so one corrupt row does not block the rest of the
 * rule set.
 */

let cachedClient: DynamoDBClient | undefined;

function getClient(): DynamoDBClient {
  if (!cachedClient) cachedClient = new DynamoDBClient({});
  return cachedClient;
}

function getTableName(): string {
  const t = process.env.LINGUISTIC_RULE_TABLE_NAME;
  if (!t) {
    throw new Error('load-rules-ddb: LINGUISTIC_RULE_TABLE_NAME env var is required');
  }
  return t;
}

interface RawRow {
  id?: string;
  pattern?: string;
  messageType?: string;
  captureMap?: Record<string, string> | string;
  priority?: number;
  enabled?: boolean;
  promptVersion?: number;
  confidence?: number;
  component?: string;
  appliesToType?: string | null;
}

function toRule(raw: RawRow): LinguisticRule | null {
  if (!raw.id || typeof raw.id !== 'string') return null;
  if (!raw.pattern || typeof raw.pattern !== 'string') return null;
  if (!raw.messageType || typeof raw.messageType !== 'string') return null;
  if (typeof raw.priority !== 'number') return null;

  let captureMap: Record<string, string> = {};
  if (typeof raw.captureMap === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw.captureMap);
      if (parsed && typeof parsed === 'object') {
        captureMap = parsed as Record<string, string>;
      }
    } catch {
      return null;
    }
  } else if (raw.captureMap && typeof raw.captureMap === 'object') {
    captureMap = raw.captureMap;
  }

  return {
    id: raw.id,
    pattern: raw.pattern,
    messageType: raw.messageType,
    captureMap,
    priority: raw.priority,
    enabled: raw.enabled !== false, // default-true when absent
    promptVersion: raw.promptVersion ?? 1,
    // Confidence: engine clamps/defaults out-of-range, so pass through.
    ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {}),
    // Component (#548): engine defaults to TYPE when absent/unknown.
    ...(raw.component === 'TYPE' ||
    raw.component === 'SENDER' ||
    raw.component === 'RECEIVER' ||
    raw.component === 'BODY'
      ? { component: raw.component }
      : {}),
    ...(raw.appliesToType ? { appliesToType: raw.appliesToType } : {}),
  };
}

/**
 * Production loader — used by the linguistic Lambda handler when it
 * lands as a consumer (out of scope here). Each cold start reads
 * the full LinguisticRule table; subsequent invocations hit the
 * engine's in-memory cache until TTL expiry.
 */
export const loadRulesFromDdb: RuleLoader = async () => {
  const client = getClient();
  const tableName = getTableName();
  const rules: LinguisticRule[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const out = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of out.Items ?? []) {
      // `unmarshall` returns `Record<string, NativeAttributeValue>`;
      // narrow via `as` because we own the shape on the producer
      // side (admin CRUD writes through GraphQL → AppSync, which
      // serialises to the same column set).
      const native = unmarshall(item) as RawRow;
      const rule = toRule(native);
      if (rule) {
        rules.push(rule);
      } else {
        console.warn('load-rules-ddb: skipping malformed rule row', { raw: native });
      }
    }
    exclusiveStartKey = out.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rules;
};
