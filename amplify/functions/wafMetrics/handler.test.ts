import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  computeWafMetrics,
  __setDeps,
  __resetDeps,
  type WafMetricsArgs,
  type WafMetricsDeps,
} from './handler';

const context = {} as Context;

function evt(args: WafMetricsArgs): AppSyncResolverEvent<WafMetricsArgs> {
  return { arguments: args } as AppSyncResolverEvent<WafMetricsArgs>;
}

function deps(over: Partial<WafMetricsDeps> = {}): WafMetricsDeps {
  return {
    metricSum: vi.fn<WafMetricsDeps['metricSum']>((name) =>
      Promise.resolve(name === 'BlockedRequests' ? 42 : 1000),
    ),
    now: () => Date.parse('2026-06-03T00:00:00Z'),
    ...over,
  };
}

describe('wafMetrics handler (#673)', () => {
  beforeEach(() => {
    process.env.WEB_ACL_NAME = 'EamWebAcl';
  });
  afterEach(() => {
    __resetDeps();
    delete process.env.WEB_ACL_NAME;
    vi.restoreAllMocks();
  });

  it('sums blocked + allowed requests over the window', async () => {
    const d = deps();
    const res = await computeWafMetrics(d, 24);
    expect(res.blockedRequests).toBe(42);
    expect(res.allowedRequests).toBe(1000);
    expect(res.windowHours).toBe(24);
    expect(res.webAcl).toBe('EamWebAcl');
    expect(res.retrievedAt).toBe('2026-06-03T00:00:00.000Z');
  });

  it('queries the window [now - windowHours, now)', async () => {
    const metricSum = vi.fn<WafMetricsDeps['metricSum']>(() => Promise.resolve(0));
    await computeWafMetrics(deps({ metricSum }), 6);
    const now = Date.parse('2026-06-03T00:00:00Z');
    expect(metricSum).toHaveBeenCalledWith('BlockedRequests', now - 6 * 3600 * 1000, now);
  });

  it('defaults to 24h and clamps invalid / oversized windows', async () => {
    __setDeps(deps());
    expect((await handler(evt({ windowHours: null }), context)).windowHours).toBe(24);
    expect((await handler(evt({ windowHours: 0 }), context)).windowHours).toBe(24);
    expect((await handler(evt({ windowHours: -5 }), context)).windowHours).toBe(24);
    expect((await handler(evt({ windowHours: 99999 }), context)).windowHours).toBe(24 * 30);
    expect((await handler(evt({ windowHours: 12 }), context)).windowHours).toBe(12);
  });
});
