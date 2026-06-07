import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import {
  handler,
  streamDeltas,
  recordImages,
  pickStatMessage,
  __setDeps,
  __resetDeps,
  type AggregateStore,
} from './handler';
import { METRICS, type CounterOp, type StatMessage } from './contributions';

function eligibleImage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'SKYKING',
    body: 'FOXTROT',
    sender: 'MAINSAIL',
    receiver: 'ALL STATIONS',
    broadcastTs: '2026-06-06T12:00:00.000Z',
    flaggedForReview: false,
    publishedAt: '2026-06-06T12:01:00.000Z',
    ...overrides,
  };
}

function streamRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  images: { OldImage?: Record<string, unknown>; NewImage?: Record<string, unknown> },
): DynamoDBStreamEvent['Records'][number] {
  return {
    eventID: '1',
    eventName,
    eventSource: 'aws:dynamodb',
    dynamodb: {
      OldImage: images.OldImage ? marshall(images.OldImage) : undefined,
      NewImage: images.NewImage ? marshall(images.NewImage) : undefined,
    },
  } as DynamoDBStreamEvent['Records'][number];
}

function deltaOf(ops: CounterOp[], metric: string, dimension: string): number {
  return ops
    .filter((o) => o.metric === metric && o.dimension === dimension)
    .reduce((a, o) => a + o.delta, 0);
}

describe('pickStatMessage + recordImages (#780)', () => {
  it('unmarshals only the stats-relevant fields', () => {
    const rec = streamRecord('INSERT', { NewImage: eligibleImage() });
    const { before, after } = recordImages(rec);
    expect(before).toBeNull();
    expect(after?.type).toBe('SKYKING');
    expect(after?.sender).toBe('MAINSAIL');
    expect(after?.flaggedForReview).toBe(false);
  });

  it('coerces missing booleans to null', () => {
    expect(pickStatMessage({ type: 'OTHER' })?.flaggedForReview).toBeNull();
  });
});

describe('streamDeltas (#780)', () => {
  it('an INSERT of an eligible message adds its contributions', () => {
    const event: DynamoDBStreamEvent = {
      Records: [streamRecord('INSERT', { NewImage: eligibleImage() })],
    };
    const ops = streamDeltas(event);
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(1);
    expect(deltaOf(ops, METRICS.CALLSIGN_USAGE, 'MAINSAIL')).toBe(1);
    expect(deltaOf(ops, METRICS.DAILY_COUNT, '2026-06-06#SKYKING')).toBe(1);
  });

  it('a REMOVE-by-soft-delete (MODIFY with deletedAt) subtracts', () => {
    const before = eligibleImage();
    const after = eligibleImage({ deletedAt: '2026-06-06T13:00:00Z' });
    const event: DynamoDBStreamEvent = {
      Records: [streamRecord('MODIFY', { OldImage: before, NewImage: after })],
    };
    const ops = streamDeltas(event);
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(-1);
  });

  it('ignores non-dynamodb records', () => {
    const event = {
      Records: [{ eventSource: 'aws:sqs' }],
    } as unknown as DynamoDBStreamEvent;
    expect(streamDeltas(event)).toEqual([]);
  });

  it('merges deltas across multiple records and drops net-zero', () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        streamRecord('INSERT', { NewImage: eligibleImage() }),
        streamRecord('MODIFY', {
          OldImage: eligibleImage(),
          NewImage: eligibleImage({ deletedAt: '2026-06-06T13:00:00Z' }),
        }),
      ],
    };
    // +1 then -1 for the same codeword → net zero, omitted.
    expect(streamDeltas(event).find((o) => o.metric === METRICS.CODEWORD_SKYKING)).toBeUndefined();
  });
});

describe('handler routing (#780)', () => {
  let applyDeltas: ReturnType<typeof vi.fn<(ops: CounterOp[], now: string) => Promise<void>>>;
  let scanMessages: ReturnType<typeof vi.fn<() => Promise<StatMessage[]>>>;
  let writeAbsolute: ReturnType<
    typeof vi.fn<
      (
        totals: Map<string, { metric: string; dimension: string; count: number }>,
        now: string,
      ) => Promise<void>
    >
  >;
  let store: AggregateStore;

  beforeEach(() => {
    applyDeltas = vi
      .fn<(ops: CounterOp[], now: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    scanMessages = vi.fn<() => Promise<StatMessage[]>>().mockResolvedValue([]);
    writeAbsolute = vi
      .fn<
        (
          totals: Map<string, { metric: string; dimension: string; count: number }>,
          now: string,
        ) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    store = {
      applyDeltas: (ops, now) => applyDeltas(ops, now),
      scanMessages: () => scanMessages(),
      writeAbsolute: (t, now) => writeAbsolute(t, now),
    };
    __setDeps({ store, now: () => new Date('2026-06-07T00:00:00.000Z') });
  });
  afterEach(() => __resetDeps());

  it('a stream event applies deltas, not a recompute', async () => {
    await handler({ Records: [streamRecord('INSERT', { NewImage: eligibleImage() })] });
    expect(applyDeltas).toHaveBeenCalledTimes(1);
    const ops = applyDeltas.mock.calls[0]![0];
    expect(deltaOf(ops, METRICS.CODEWORD_SKYKING, 'FOXTROT')).toBe(1);
    expect(applyDeltas.mock.calls[0]![1]).toBe('2026-06-07T00:00:00.000Z');
    expect(writeAbsolute).not.toHaveBeenCalled();
  });

  it('a stream event with no net deltas does not call the store', async () => {
    await handler({
      Records: [
        streamRecord('MODIFY', {
          OldImage: eligibleImage({ flaggedForReview: true }),
          NewImage: eligibleImage({ flaggedForReview: true, body: 'CHANGED' }),
        }),
      ],
    });
    expect(applyDeltas).not.toHaveBeenCalled();
  });

  it('a scheduled (non-stream) event triggers a full recompute', async () => {
    const corpus: StatMessage[] = [
      {
        type: 'SKYKING',
        body: 'FOXTROT',
        broadcastTs: '2026-06-06T12:00:00Z',
        flaggedForReview: false,
        publishedAt: '2026-06-06T12:01:00Z',
        deletedAt: null,
        sender: null,
        receiver: null,
      },
    ];
    scanMessages.mockResolvedValue(corpus);
    await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' });
    expect(scanMessages).toHaveBeenCalledTimes(1);
    expect(writeAbsolute).toHaveBeenCalledTimes(1);
    const totals = writeAbsolute.mock.calls[0]![0] as Map<
      string,
      { metric: string; dimension: string; count: number }
    >;
    expect(totals.get('codeword-skyking#FOXTROT')?.count).toBe(1);
    expect(applyDeltas).not.toHaveBeenCalled();
  });
});
