import { describe, it, expect } from 'vitest';
import {
  request,
  response,
  type CastRevisionVoteArgs,
  type CastRevisionVoteContext,
  type UpdateItemOperation,
} from './cast-revision-vote.js';

/**
 * Resolver-behavior tests for `castRevisionVote` (#35).
 *
 * Mirrors the cast-field-vote tests + weight-snapshot pattern from
 * #33; RevisionVote uses a compound `(revisionId, voterId)` PK so
 * no synthesised fieldKey like FieldVote needs.
 */

function ctxFor(
  args: CastRevisionVoteArgs,
  identitySub = 'sub-voter-1',
  result?: Record<string, unknown>,
  prev?: { result?: { computedWeight?: number } | null },
): CastRevisionVoteContext {
  return {
    arguments: args,
    identity: { sub: identitySub },
    result,
    prev,
  };
}

describe('castRevisionVote request resolver', () => {
  it('writes the compound (revisionId, voterId) PK', () => {
    const op: UpdateItemOperation = request(
      ctxFor({ revisionId: 'rev-1', value: 'UP' }, 'sub-voter-1'),
    );
    expect(op.operation).toBe('UpdateItem');
    expect(op.key.revisionId?.S).toBe('rev-1');
    expect(op.key.voterId?.S).toBe('sub-voter-1');
  });

  it('pins voterId via if_not_exists so re-casts never re-stamp it', () => {
    const op = request(ctxFor({ revisionId: 'rev-1', value: 'UP' }));
    expect(op.update.expression).toMatch(/#voterId = if_not_exists/);
  });

  it('overwrites value on every call (re-casts flip UP / DOWN)', () => {
    const op = request(ctxFor({ revisionId: 'rev-1', value: 'DOWN' }));
    expect(op.update.expression).toMatch(/#value = :value/);
    expect(op.update.expressionValues[':value']?.S).toBe('DOWN');
  });

  it('derives voterId from ctx.identity.sub (sub-as-id, #259)', () => {
    const op = request(ctxFor({ revisionId: 'rev-7', value: 'UP' }, 'sub-voter-from-jwt'));
    expect(op.update.expressionValues[':voterId']?.S).toBe('sub-voter-from-jwt');
    expect(op.key.voterId?.S).toBe('sub-voter-from-jwt');
  });

  it('rejects an empty revisionId argument', () => {
    expect(() => request(ctxFor({ revisionId: '', value: 'UP' }))).toThrow(/revisionId/i);
  });

  it('rejects a missing value argument', () => {
    expect(() =>
      request(
        ctxFor({
          revisionId: 'rev-1',
          // @ts-expect-error — runtime guard
          value: '',
        }),
      ),
    ).toThrow(/value/i);
  });

  it('rejects an invalid value (must be UP or DOWN)', () => {
    expect(() =>
      request(
        ctxFor({
          revisionId: 'rev-1',
          // @ts-expect-error — runtime guard
          value: 'MAYBE',
        }),
      ),
    ).toThrow(/UP or DOWN/);
  });

  it('rejects an unauthenticated request (ctx.identity.sub missing)', () => {
    const ctx: CastRevisionVoteContext = {
      arguments: { revisionId: 'rev-1', value: 'UP' },
      identity: undefined,
    };
    expect(() => request(ctx)).toThrow(/identity/i);
  });

  it('snapshots weightAtVoteTime from ctx.prev.result.computedWeight', () => {
    const op = request(
      ctxFor({ revisionId: 'rev-w', value: 'UP' }, 'sub-voter-w', undefined, {
        result: { computedWeight: 3.5 },
      }),
    );
    expect(op.update.expression).toMatch(/#weightAtVoteTime = if_not_exists/);
    expect(op.update.expressionValues[':weightAtVoteTime']?.N).toBe('3.5');
  });

  it('falls back to weight=1 when ctx.prev.result is null', () => {
    const op = request(
      ctxFor({ revisionId: 'rev-w', value: 'UP' }, 'sub-voter-w', undefined, {
        result: null,
      }),
    );
    expect(op.update.expressionValues[':weightAtVoteTime']?.N).toBe('1');
  });

  it('falls back to weight=1 when ctx.prev is missing entirely', () => {
    const op = request(ctxFor({ revisionId: 'rev-w', value: 'UP' }, 'sub-voter-w'));
    expect(op.update.expressionValues[':weightAtVoteTime']?.N).toBe('1');
  });
});

describe('castRevisionVote response resolver', () => {
  it('returns the upserted row to the caller', () => {
    const row = {
      revisionId: 'rev-1',
      voterId: 'sub-voter-1',
      value: 'UP',
      weightAtVoteTime: 1,
    };
    const result = response(ctxFor({ revisionId: 'rev-1', value: 'UP' }, 'sub-voter-1', row));
    expect(result).toEqual(row);
  });
});
