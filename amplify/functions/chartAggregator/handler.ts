import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { accumulate, diffOps, type CounterOp, type StatMessage } from './contributions';

/**
 * chartAggregator handler (#780).
 *
 * Routes on the incoming event:
 *   - a DynamoDB stream event (Message table) → incremental counter deltas.
 *   - anything else (the EventBridge schedule) → a full recompute.
 *
 * All DynamoDB I/O is behind the injectable `AggregateStore` port so the
 * routing + delta logic is unit-testable without AWS. The default store
 * (`./store`) is loaded lazily so importing this module in a test never pulls
 * in the AWS SDK clients.
 */

/** The narrow persistence surface the handler needs. */
export interface AggregateStore {
  /** Apply net counter deltas (atomic ADD per op). */
  applyDeltas: (ops: CounterOp[], nowIso: string) => Promise<void>;
  /** Full Scan of the Message table → every row as a StatMessage. */
  scanMessages: () => Promise<StatMessage[]>;
  /** Overwrite the table with absolute counts, pruning rows not in `totals`. */
  writeAbsolute: (
    totals: Map<string, { metric: string; dimension: string; count: number }>,
    nowIso: string,
  ) => Promise<void>;
}

interface Deps {
  store?: AggregateStore;
  now?: () => Date;
}

let injected: Deps = {};

/** Test seam — inject a fake store / clock. */
export function __setDeps(deps: Deps): void {
  injected = deps;
}
export function __resetDeps(): void {
  injected = {};
}

let cachedStore: AggregateStore | undefined;
async function getStore(): Promise<AggregateStore> {
  if (injected.store) return injected.store;
  if (!cachedStore) {
    const mod = await import('./store');
    cachedStore = mod.createDynamoStore();
  }
  return cachedStore;
}

/** Pick only the stats-relevant fields off an unmarshalled Message image. */
export function pickStatMessage(image: Record<string, unknown> | undefined): StatMessage | null {
  if (!image) return null;
  const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    type: s(image.type),
    body: s(image.body),
    sender: s(image.sender),
    receiver: s(image.receiver),
    broadcastTs: s(image.broadcastTs),
    deletedAt: s(image.deletedAt),
    flaggedForReview: typeof image.flaggedForReview === 'boolean' ? image.flaggedForReview : null,
    publishedAt: s(image.publishedAt),
  };
}

/** The before/after StatMessages carried by one stream record. */
export function recordImages(record: DynamoDBRecord): {
  before: StatMessage | null;
  after: StatMessage | null;
} {
  const ddb = record.dynamodb;
  const old = ddb?.OldImage
    ? unmarshall(ddb.OldImage as Record<string, AttributeValue>)
    : undefined;
  const next = ddb?.NewImage
    ? unmarshall(ddb.NewImage as Record<string, AttributeValue>)
    : undefined;
  return { before: pickStatMessage(old), after: pickStatMessage(next) };
}

/** Net counter deltas across every record in a stream batch (pure). */
export function streamDeltas(event: DynamoDBStreamEvent): CounterOp[] {
  const net = new Map<string, number>();
  for (const record of event.Records ?? []) {
    if (record.eventSource !== 'aws:dynamodb') continue;
    const { before, after } = recordImages(record);
    for (const op of diffOps(before, after)) {
      const key = `${op.metric} ${op.dimension}`;
      net.set(key, (net.get(key) ?? 0) + op.delta);
    }
  }
  const out: CounterOp[] = [];
  for (const [key, delta] of net) {
    if (delta === 0) continue;
    const idx = key.indexOf(' ');
    out.push({ metric: key.slice(0, idx), dimension: key.slice(idx + 1), delta });
  }
  return out;
}

function isStreamEvent(event: unknown): event is DynamoDBStreamEvent {
  if (!event || typeof event !== 'object') return false;
  const records = (event as { Records?: unknown }).Records;
  return (
    Array.isArray(records) &&
    records.some(
      (r) =>
        r &&
        typeof r === 'object' &&
        (r as { eventSource?: unknown }).eventSource === 'aws:dynamodb',
    )
  );
}

/** Full recompute: scan Messages → absolute counts → overwrite + prune. */
export async function recompute(store: AggregateStore, nowIso: string): Promise<void> {
  const messages = await store.scanMessages();
  const totals = accumulate(messages);
  await store.writeAbsolute(totals, nowIso);
}

export async function handler(event: unknown): Promise<void> {
  const store = await getStore();
  const nowIso = (injected.now ? injected.now() : new Date()).toISOString();

  if (isStreamEvent(event)) {
    const ops = streamDeltas(event);
    if (ops.length > 0) await store.applyDeltas(ops, nowIso);
    return;
  }

  // EventBridge schedule (or a manual invoke) → full recompute / backfill.
  await recompute(store, nowIso);
}
