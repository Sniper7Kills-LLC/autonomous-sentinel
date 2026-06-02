import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import { handler, extractRequestedBy, __setDeps, __resetDeps, type TriggerDeps } from './handler';

const context = {} as Context;
const cb = () => undefined;

function event(identity: unknown): AppSyncResolverEvent<unknown> {
  return { arguments: {}, identity, source: null } as unknown as AppSyncResolverEvent<unknown>;
}

describe('costSnapshotTrigger handler (#303)', () => {
  beforeEach(() => {
    __resetDeps();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('fires exactly one PutEvents and returns { status: queued }', async () => {
    const putSpy = vi.fn<TriggerDeps['putEvents']>(() => Promise.resolve());
    __setDeps({ putEvents: putSpy });

    const out = await handler(event({ sub: 'admin-123' }), context, cb);

    expect(out).toEqual({ status: 'queued' });
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith({ requestedBy: 'admin-123' });
  });

  it('stamps requestedBy=null when identity has no sub', async () => {
    const putSpy = vi.fn<TriggerDeps['putEvents']>(() => Promise.resolve());
    __setDeps({ putEvents: putSpy });

    await handler(event({}), context, cb);

    expect(putSpy).toHaveBeenCalledWith({ requestedBy: null });
  });

  it('propagates a PutEvents failure (surfaces as a resolver error)', async () => {
    __setDeps({ putEvents: vi.fn(() => Promise.reject(new Error('PutEvents failed'))) });
    await expect(handler(event({ sub: 'x' }), context, cb)).rejects.toThrow('PutEvents failed');
  });

  describe('extractRequestedBy', () => {
    it('reads sub from a cognito identity', () => {
      expect(extractRequestedBy({ sub: 'abc' })).toBe('abc');
    });
    it('returns null for missing / malformed identity', () => {
      expect(extractRequestedBy(null)).toBe(null);
      expect(extractRequestedBy(undefined)).toBe(null);
      expect(extractRequestedBy({})).toBe(null);
      expect(extractRequestedBy('nope')).toBe(null);
    });
  });
});
