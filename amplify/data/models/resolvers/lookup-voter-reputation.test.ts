import { describe, it, expect } from 'vitest';
import { request, response, type LookupVoterReputationContext } from './lookup-voter-reputation.js';

/**
 * Resolver-behavior tests for the `castFieldVote` weight-snapshot
 * pipeline step (#33). Step 1 GetItems Reputation by `userId =
 * ctx.identity.sub`; step 2 (cast-field-vote.js) reads the result
 * from `ctx.prev.result?.computedWeight`.
 */

function ctxFor(
  identity: { sub?: string } | null | undefined,
  result?: { computedWeight?: number } | null,
): LookupVoterReputationContext {
  return { identity, result };
}

describe('lookup-voter-reputation request resolver (#33)', () => {
  it('issues a GetItem on Reputation keyed by the JWT sub', () => {
    const op = request(ctxFor({ sub: 'cog-voter-1' }));
    expect(op.operation).toBe('GetItem');
    expect(op.key.userId?.S).toBe('cog-voter-1');
  });

  it('projects only the computedWeight column to keep the read cheap', () => {
    const op = request(ctxFor({ sub: 'cog-voter-2' }));
    expect(op.projection?.expression).toMatch(/computedWeight|#cw/);
    expect(op.projection?.expressionNames?.['#cw']).toBe('computedWeight');
  });

  it('rejects an unauthenticated request (ctx.identity null)', () => {
    expect(() => request(ctxFor(null))).toThrow(/identity/i);
  });

  it('rejects when ctx.identity has no sub claim', () => {
    expect(() => request(ctxFor({}))).toThrow(/identity/i);
  });
});

describe('lookup-voter-reputation response resolver (#33)', () => {
  it('returns the Reputation row when it exists', () => {
    const row = { computedWeight: 2.5 };
    const result = response(ctxFor({ sub: 'cog-voter-1' }, row));
    expect(result).toEqual(row);
  });

  it('returns null when the Reputation row is missing (pre-#36 lazy-create users)', () => {
    const result = response(ctxFor({ sub: 'cog-voter-1' }, null));
    expect(result).toBeNull();
  });

  it('treats undefined result the same as missing row', () => {
    const result = response(ctxFor({ sub: 'cog-voter-1' }));
    expect(result).toBeNull();
  });
});
