import type { Handler, SQSEvent } from 'aws-lambda';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  S3Client,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import {
  BatchWriteItemCommand,
  type BatchWriteItemCommandOutput,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';
import {
  mapCostExplorerRows,
  mapLambdaMetricRows,
  mapS3PrefixRows,
  accumulateS3Prefixes,
  previousUtcDate,
  type CostRow,
} from './cost-rows';

/**
 * `costSnapshotWorker` — daily 05:00 UTC cron that snapshots AWS spend
 * for the public `/transparency` page (#303).
 *
 * Three sources, each wrapped in its own try/catch so one failing
 * (throttle, missing permission, empty bucket) logs + continues rather
 * than aborting the run:
 *   1. Cost Explorer GetCostAndUsage (DAILY, GroupBy=SERVICE).
 *   2. CloudWatch GetMetricData (Lambda Invocations + Duration).
 *   3. S3 ListObjectsV2 over the media bucket → per-prefix sizes.
 *
 * All resulting rows are BatchWriteItem'd into the CostSnapshot table.
 *
 * Deps are injectable so the handler is unit-testable with mocked AWS
 * SDK clients (mirrors the fieldVoteOrphanJanitor pattern).
 */

const COST_SNAPSHOT_TABLE_ENV = 'COST_SNAPSHOT_TABLE_NAME';
const MEDIA_BUCKET_ENV = 'MEDIA_BUCKET_NAME';
/** Comma-separated Lambda function names to pull CloudWatch metrics for. */
const LAMBDA_FUNCTION_NAMES_ENV = 'COST_LAMBDA_FUNCTION_NAMES';

export interface WorkerDeps {
  fetchCostExplorer: (snapshotDate: string) => Promise<CostRow[]>;
  fetchLambdaMetrics: (snapshotDate: string) => Promise<CostRow[]>;
  fetchS3Prefixes: (snapshotDate: string) => Promise<CostRow[]>;
  writeRows: (rows: CostRow[]) => Promise<void>;
  now: () => Date;
}

let injected: Partial<WorkerDeps> = {};

export function __setDeps(deps: Partial<WorkerDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

function tableName(): string {
  const v = process.env[COST_SNAPSHOT_TABLE_ENV];
  if (!v) throw new Error(`costSnapshotWorker: ${COST_SNAPSHOT_TABLE_ENV} env var is required`);
  return v;
}

let cachedCe: CostExplorerClient | undefined;
function ceClient(): CostExplorerClient {
  if (!cachedCe) cachedCe = new CostExplorerClient({});
  return cachedCe;
}

let cachedCw: CloudWatchClient | undefined;
function cwClient(): CloudWatchClient {
  if (!cachedCw) cachedCw = new CloudWatchClient({});
  return cachedCw;
}

let cachedS3: S3Client | undefined;
function s3Client(): S3Client {
  if (!cachedS3) cachedS3 = new S3Client({});
  return cachedS3;
}

/**
 * Cost Explorer DAILY window is half-open [Start, End). To report the
 * previous UTC day we ask for [snapshotDate, today].
 */
async function defaultFetchCostExplorer(snapshotDate: string): Promise<CostRow[]> {
  const end = new Date(`${snapshotDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const endStr = end.toISOString().slice(0, 10);
  const res = await ceClient().send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: snapshotDate, End: endStr },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );
  const groups = (res.ResultsByTime ?? []).flatMap((r) =>
    (r.Groups ?? []).map((g) => ({
      service: g.Keys?.[0] ?? 'Unknown',
      amount: g.Metrics?.UnblendedCost?.Amount ?? '0',
      unit: g.Metrics?.UnblendedCost?.Unit ?? 'USD',
    })),
  );
  return mapCostExplorerRows(snapshotDate, groups);
}

async function defaultFetchLambdaMetrics(snapshotDate: string): Promise<CostRow[]> {
  const names = (process.env[LAMBDA_FUNCTION_NAMES_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return [];

  const start = new Date(`${snapshotDate}T00:00:00Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  // One Invocations (Sum) + one Duration (Sum) metric query per
  // function. GetMetricData caps at 500 queries; ~15 functions is
  // well within limits.
  const queries = names.flatMap((name, i) => [
    {
      Id: `inv${i}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Invocations',
          Dimensions: [{ Name: 'FunctionName', Value: name }],
        },
        Period: 86400,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
    {
      Id: `dur${i}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/Lambda',
          MetricName: 'Duration',
          Dimensions: [{ Name: 'FunctionName', Value: name }],
        },
        Period: 86400,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
  ]);

  const res = await cwClient().send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: queries,
    }),
  );

  const byId = new Map<string, number>();
  for (const r of res.MetricDataResults ?? []) {
    const sum = (r.Values ?? []).reduce((a, b) => a + b, 0);
    if (r.Id) byId.set(r.Id, sum);
  }

  const metrics = names.map((name, i) => {
    const invocations = byId.get(`inv${i}`) ?? 0;
    // Duration sum is in milliseconds; report seconds (GB-second proxy
    // before applying memory; the page surfaces raw seconds in meta).
    const durationGbSeconds = (byId.get(`dur${i}`) ?? 0) / 1000;
    return { functionName: name, invocations, durationGbSeconds };
  });
  return mapLambdaMetricRows(snapshotDate, metrics);
}

async function defaultFetchS3Prefixes(snapshotDate: string): Promise<CostRow[]> {
  const bucket = process.env[MEDIA_BUCKET_ENV];
  if (!bucket) return [];

  const objects: { key: string; size: number }[] = [];
  let continuationToken: string | undefined;
  // Bound the scan so a very large bucket doesn't blow the 60s budget;
  // 50 pages * 1000 keys = 50k objects sampled per run.
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res: ListObjectsV2CommandOutput = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) objects.push({ key: obj.Key, size: obj.Size ?? 0 });
    }
    if (!res.IsTruncated) break;
    continuationToken = res.NextContinuationToken;
    if (!continuationToken) break;
  }

  return mapS3PrefixRows(snapshotDate, accumulateS3Prefixes(objects));
}

/**
 * Build the DynamoDB item for one CostRow.
 *
 * `createdAt` / `updatedAt` are stamped here because these rows are written
 * straight to DynamoDB via `BatchWriteItem` (bypassing AppSync). Amplify Data
 * auto-adds both to the `CostSnapshot` model as non-nullable `AWSDateTime!`,
 * but only stamps them on AppSync mutations — a raw SDK PutRequest must set
 * them itself or every subsequent `listCostSnapshots` read fails with a
 * "Cannot return null for non-nullable type: 'AWSDateTime'" error (#649).
 *
 * Daily rows overwrite the same `(snapshotDate, subject)` key, so a plain Put
 * resets both timestamps on re-run; acceptable for a daily snapshot.
 */
export function buildSnapshotItem(row: CostRow, nowIso: string) {
  return {
    snapshotDate: row.snapshotDate,
    subject: row.subject,
    category: row.category,
    usdAmount: row.usdAmount,
    unit: row.unit,
    meta: JSON.stringify(row.meta),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

async function defaultWriteRows(rows: CostRow[]): Promise<void> {
  if (rows.length === 0) return;
  const table = tableName();
  const nowIso = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    const requests: WriteRequest[] = chunk.map((row) => ({
      PutRequest: {
        Item: marshall(buildSnapshotItem(row, nowIso), { removeUndefinedValues: true }),
      },
    }));
    let pending: WriteRequest[] | undefined = requests;
    let attempt = 0;
    while (pending && pending.length > 0) {
      const res: BatchWriteItemCommandOutput = await getDdbClient().send(
        new BatchWriteItemCommand({ RequestItems: { [table]: pending } }),
      );
      pending = res.UnprocessedItems?.[table];
      if (!pending || pending.length === 0) break;
      attempt += 1;
      if (attempt >= 3) {
        throw new Error(
          `costSnapshotWorker: BatchWriteItem left ${pending.length} unprocessed rows after 3 retries`,
        );
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
  }
}

function resolveDeps(): WorkerDeps {
  return {
    fetchCostExplorer: injected.fetchCostExplorer ?? defaultFetchCostExplorer,
    fetchLambdaMetrics: injected.fetchLambdaMetrics ?? defaultFetchLambdaMetrics,
    fetchS3Prefixes: injected.fetchS3Prefixes ?? defaultFetchS3Prefixes,
    writeRows: injected.writeRows ?? defaultWriteRows,
    now: injected.now ?? (() => new Date()),
  };
}

/** Small summary returned by the snapshot core (logged, not surfaced). */
export interface SnapshotResult {
  snapshotDate: string;
  rowsWritten: number;
  totalUsd: number;
}

/**
 * Shared snapshot core — used by BOTH invocation paths (the 05:00 cron
 * and the SQS-driven admin `runCostSnapshotNow` manual sync). Pulls the
 * three fault-tolerant sources, writes the rows, and returns a small
 * summary.
 */
async function runSnapshot(deps: WorkerDeps): Promise<SnapshotResult> {
  const snapshotDate = previousUtcDate(deps.now());

  const rows: CostRow[] = [];

  // Each source is independently fault-tolerant — a failure in one
  // (e.g. Cost Explorer throttle, empty bucket) must not lose the
  // other two sources' rows.
  try {
    rows.push(...(await deps.fetchCostExplorer(snapshotDate)));
  } catch (err) {
    console.error('costSnapshotWorker: Cost Explorer fetch failed; continuing', { err });
  }

  try {
    rows.push(...(await deps.fetchLambdaMetrics(snapshotDate)));
  } catch (err) {
    console.error('costSnapshotWorker: CloudWatch metrics fetch failed; continuing', { err });
  }

  try {
    rows.push(...(await deps.fetchS3Prefixes(snapshotDate)));
  } catch (err) {
    console.error('costSnapshotWorker: S3 prefix scan failed; continuing', { err });
  }

  try {
    await deps.writeRows(rows);
  } catch (err) {
    console.error('costSnapshotWorker: row write failed', { err });
    throw err;
  }

  const totalUsd = Math.round(rows.reduce((sum, r) => sum + (r.usdAmount ?? 0), 0) * 100) / 100;

  console.info('costSnapshotWorker: snapshot complete', {
    snapshotDate,
    rowCount: rows.length,
    totalUsd,
  });

  return { snapshotDate, rowsWritten: rows.length, totalUsd };
}

/**
 * Detect the SQS-driven manual-sync invocation. The admin
 * `runCostSnapshotNow` mutation routes through `costSnapshotTrigger`,
 * which enqueues a message; this Lambda is wired as an SQS event source
 * on that queue (#644). SQS batches carry an `event.Records` array.
 *
 * The worker is NO LONGER an AppSync resolver — binding it as one closed
 * a FunctionDirectiveStack ↔ data CloudFormation cycle (#644). It only
 * ever serves two event sources now: the EventBridge cron and this SQS
 * queue. Both run the identical `runSnapshot` core and return void.
 */
export function isSqsEvent(event: unknown): event is SQSEvent {
  if (typeof event !== 'object' || event === null) return false;
  return Array.isArray((event as Record<string, unknown>).Records);
}

/**
 * Dual-source handler. Both invocation paths — the 05:00 EventBridge
 * cron and the SQS manual-sync message produced by `costSnapshotTrigger`
 * — run the identical `runSnapshot` core and return `void` (neither
 * source consumes a return value; the admin UI refetches the rows). An
 * SQS-path failure rethrows so the message redrives / lands on the DLQ.
 */
// `_context`/`_callback` are declared (unused) so the 3-arg Lambda
// `Handler` call sites in the tests are not flagged as superfluous by
// CodeQL (js/superfluous-trailing-arguments) — same fix as #400.
export const handler: Handler<unknown, void> = async (event, _context, _callback) => {
  const deps = resolveDeps();
  // Both the cron and the SQS manual-sync run the same snapshot core.
  // `isSqsEvent` is exported for explicit unit coverage of the
  // manual-sync path; the core call is unconditional.
  void isSqsEvent(event);
  await runSnapshot(deps);
};
