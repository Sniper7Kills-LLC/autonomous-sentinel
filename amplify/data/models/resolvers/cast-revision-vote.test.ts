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

  it('does NOT set voterId in the update expression (it is a key attribute, #663)', () => {
    const op = request(ctxFor({ revisionId: 'rev-1', value: 'UP' }));
    // voterId is the RANGE half of the composite PK — DynamoDB rejects
    // setting a key attribute in an UpdateExpression. It is written from
    // the `key` parameter on upsert instead.
    expect(op.update.expression).not.toMatch(/#voterId/);
    expect(op.update.expressionValues[':voterId']).toBeUndefined();
    expect(op.update.expressionNames['#voterId']).toBeUndefined();
    // ...but it IS still part of the key.
    expect(op.key.voterId?.S).toBe('sub-voter-1');
  });

  it('overwrites value on every call (re-casts flip UP / DOWN)', () => {
    const op = request(ctxFor({ revisionId: 'rev-1', value: 'DOWN' }));
    expect(op.update.expression).toMatch(/#value = :value/);
    expect(op.update.expressionValues[':value']?.S).toBe('DOWN');
  });

  it('derives voterId from ctx.identity.sub (sub-as-id, #259)', () => {
    const op = request(ctxFor({ revisionId: 'rev-7', value: 'UP' }, 'sub-voter-from-jwt'));
    // voterId flows into the key (not the SET expression — see #663 above).
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

  it('stamps createdAt (once) + updatedAt (always) so AWSDateTime! reads pass (#665)', () => {
    const op = request(ctxFor({ revisionId: 'rev-1', value: 'UP' }, 'sub-1'));
    expect(op.update.expression).toMatch(/#createdAt = if_not_exists\(#createdAt, :now\)/);
    expect(op.update.expression).toMatch(/#updatedAt = :now/);
    expect(op.update.expressionValues[':now']?.S).toBeTruthy();
  });

  it('surfaces a data-source error instead of swallowing it (#663)', () => {
    const ctx = {
      arguments: { revisionId: 'rev-1', value: 'UP' },
      identity: { sub: 'sub-voter-1' },
      error: { message: 'Cannot update attribute voterId', type: 'DynamoDB:ValidationException' },
    } as unknown as CastRevisionVoteContext;
    expect(() => response(ctx)).toThrow(/Cannot update attribute voterId/);
  });
});
