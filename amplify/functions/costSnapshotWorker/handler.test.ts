import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ScheduledEvent, SQSEvent, Context } from 'aws-lambda';
import {
  handler,
  isSqsEvent,
  buildSnapshotItem,
  __setDeps,
  __resetDeps,
  type WorkerDeps,
} from './handler';
import type { CostRow } from './cost-rows';

const event = {} as ScheduledEvent;
const context = {} as Context;
const cb = () => undefined;

/** A minimal SQS event — the manual-sync path produced by costSnapshotTrigger. */
const sqsEvent = {
  Records: [{ body: JSON.stringify({ source: 'admin.runCostSnapshotNow' }) }],
} as unknown as SQSEvent;

function row(subject: string): CostRow {
  return {
    snapshotDate: '2026-05-31',
    subject,
    category: 'AWS_SERVICE',
    usdAmount: 1,
    unit: 'USD',
    meta: {},
  };
}

describe('costSnapshotWorker handler (#303)', () => {
  beforeEach(() => {
    __resetDeps();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('writes the union of all three sources for the previous UTC day', async () => {
    const writeSpy = vi.fn<WorkerDeps['writeRows']>(() => Promise.resolve());
    const deps: WorkerDeps = {
      fetchCostExplorer: vi.fn<WorkerDeps['fetchCostExplorer']>((d) =>
        Promise.resolve([{ ...row('AWS Lambda'), snapshotDate: d }]),
      ),
      fetchLambdaMetrics: vi.fn(() => Promise.resolve([row('preprocess')])),
      fetchS3Prefixes: vi.fn(() => Promise.resolve([row('recordings/originals/')])),
      writeRows: writeSpy,
      now: () => new Date('2026-06-01T05:00:00.000Z'),
    };
    __setDeps(deps);

    await handler(event, context, cb);

    expect(deps.fetchCostExplorer).toHaveBeenCalledWith('2026-05-31');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = writeSpy.mock.calls[0]![0];
    expect(written.map((r) => r.subject)).toEqual([
      'AWS Lambda',
      'preprocess',
      'recordings/originals/',
    ]);
  });

  it('continues writing the other sources when one source throws', async () => {
    const writeSpy = vi.fn<WorkerDeps['writeRows']>(() => Promise.resolve());
    __setDeps({
      fetchCostExplorer: vi.fn(() => Promise.reject(new Error('CE throttled'))),
      fetchLambdaMetrics: vi.fn(() => Promise.resolve([row('preprocess')])),
      fetchS3Prefixes: vi.fn(() => Promise.resolve([row('recordings/web/')])),
      writeRows: writeSpy,
      now: () => new Date('2026-06-01T05:00:00.000Z'),
    });

    await handler(event, context, cb);

    const written = writeSpy.mock.calls[0]![0];
    expect(written.map((r) => r.subject)).toEqual(['preprocess', 'recordings/web/']);
    expect(console.error).toHaveBeenCalled();
  });

  it('still attempts a write (empty) when all sources fail', async () => {
    const writeSpy = vi.fn<WorkerDeps['writeRows']>(() => Promise.resolve());
    __setDeps({
      fetchCostExplorer: vi.fn(() => Promise.reject(new Error('x'))),
      fetchLambdaMetrics: vi.fn(() => Promise.reject(new Error('y'))),
      fetchS3Prefixes: vi.fn(() => Promise.reject(new Error('z'))),
      writeRows: writeSpy,
      now: () => new Date('2026-06-01T05:00:00.000Z'),
    });

    await handler(event, context, cb);

    expect(writeSpy).toHaveBeenCalledWith([]);
  });

  it('rethrows when the row write itself fails (lets Lambda retry / DLQ)', async () => {
    __setDeps({
      fetchCostExplorer: vi.fn(() => Promise.resolve([row('AWS Lambda')])),
      fetchLambdaMetrics: vi.fn(() => Promise.resolve([])),
      fetchS3Prefixes: vi.fn(() => Promise.resolve([])),
      writeRows: vi.fn(() => Promise.reject(new Error('DDB down'))),
      now: () => new Date('2026-06-01T05:00:00.000Z'),
    });

    await expect(handler(event, context, cb)).rejects.toThrow('DDB down');
  });

  describe('buildSnapshotItem — Amplify auto-fields (#649)', () => {
    it('stamps non-null createdAt + updatedAt so AWSDateTime! reads do not fail', () => {
      const nowIso = '2026-06-01T05:00:00.000Z';
      const item = buildSnapshotItem(row('AWS Lambda'), nowIso);
      expect(item.createdAt).toBe(nowIso);
      expect(item.updatedAt).toBe(nowIso);
    });

    it('preserves the row business fields and serializes meta to JSON', () => {
      const item = buildSnapshotItem(
        { ...row('preprocess'), meta: { invocations: 12 } },
        '2026-06-01T05:00:00.000Z',
      );
      expect(item.snapshotDate).toBe('2026-05-31');
      expect(item.subject).toBe('preprocess');
      expect(item.category).toBe('AWS_SERVICE');
      expect(item.meta).toBe(JSON.stringify({ invocations: 12 }));
    });
  });

  describe('event-shape detection', () => {
    it('classifies SQS batches (manual-sync path) as SQS events', () => {
      expect(isSqsEvent({ Records: [] })).toBe(true);
      expect(isSqsEvent({ Records: [{ body: '{}' }] })).toBe(true);
    });

    it('classifies EventBridge scheduled events as NOT SQS', () => {
      expect(isSqsEvent({ source: 'aws.events' })).toBe(false);
      expect(isSqsEvent({ 'detail-type': 'Scheduled Event' })).toBe(false);
      expect(isSqsEvent({})).toBe(false);
    });

    it('rejects non-object events', () => {
      expect(isSqsEvent(null)).toBe(false);
      expect(isSqsEvent('cron')).toBe(false);
    });
  });

  describe('both event sources share the same core', () => {
    function makeDeps(): WorkerDeps {
      return {
        fetchCostExplorer: vi.fn(() => Promise.resolve([row('AWS Lambda')])),
        fetchLambdaMetrics: vi.fn(() => Promise.resolve([row('preprocess')])),
        fetchS3Prefixes: vi.fn(() => Promise.resolve([row('recordings/originals/')])),
        writeRows: vi.fn(() => Promise.resolve()),
        now: () => new Date('2026-06-01T05:00:00.000Z'),
      };
    }

    it('scheduled (cron) invocation runs the core and returns void', async () => {
      const deps = makeDeps();
      __setDeps(deps);
      const out = await handler({ source: 'aws.events' }, context, cb);
      expect(out).toBeUndefined();
      expect(deps.writeRows).toHaveBeenCalledTimes(1);
    });

    it('SQS (manual-sync) invocation runs the same core and returns void', async () => {
      const deps = makeDeps();
      __setDeps(deps);
      const out = await handler(sqsEvent, context, cb);
      expect(out).toBeUndefined();
      expect(deps.writeRows).toHaveBeenCalledTimes(1);
    });
  });
});
