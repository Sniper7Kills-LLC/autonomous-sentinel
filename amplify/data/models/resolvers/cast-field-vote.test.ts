import { describe, it, expect } from 'vitest';
import {
  request,
  response,
  type CastFieldVoteArgs,
  type CastFieldVoteContext,
  type UpdateItemOperation,
} from './cast-field-vote.js';

/**
 * Resolver-behavior tests for `castFieldVote` (issue #266).
 *
 * Acceptance criteria checked here:
 *   - Synthesised composite PK `<messageId>#<field>#<voterId>` written
 *     to the `fieldKey` column at request time.
 *   - voterId is derived from `ctx.identity.sub` (sub-as-id, #259) — the
 *     client never supplies it.
 *   - Idempotent upsert: re-casting the same vote refreshes the value
 *     without creating a duplicate row (the row's natural identity is
 *     the composite key).
 *   - Empty / missing arguments fail fast.
 */

function ctxFor(
  args: CastFieldVoteArgs,
  identitySub = 'sub-voter-1',
  result?: Record<string, unknown>,
): CastFieldVoteContext {
  return {
    arguments: args,
    identity: { sub: identitySub },
    result,
  };
}

describe('castFieldVote request resolver', () => {
  it('synthesises fieldKey as <messageId>#<field>#<voterId>', () => {
    const op: UpdateItemOperation = request(
      ctxFor({ messageId: 'msg-123', field: 'SENDER', value: 'SKYKING' }, 'sub-voter-1'),
    );

    expect(op.operation).toBe('UpdateItem');
    expect(op.key.fieldKey?.S).toBe('msg-123#SENDER#sub-voter-1');
  });

  it('writes messageId, field, voterId, and value into the row', () => {
    const op = request(
      ctxFor({ messageId: 'msg-abc', field: 'TYPE', value: 'SKYKING' }, 'sub-voter-9'),
    );

    // The composite key column itself must be persisted on first write.
    expect(op.update.expression).toMatch(/#fieldKey = if_not_exists/);
    // messageId / field / voterId are pinned on first write but never
    // overwritten — the natural key components must stay stable.
    expect(op.update.expression).toMatch(/#messageId = if_not_exists/);
    expect(op.update.expression).toMatch(/#field = if_not_exists/);
    expect(op.update.expression).toMatch(/#voterId = if_not_exists/);
    // The vote `value` is the mutable bit — re-casting overwrites it.
    expect(op.update.expression).toMatch(/#value = :value/);

    expect(op.update.expressionValues[':messageId']?.S).toBe('msg-abc');
    expect(op.update.expressionValues[':field']?.S).toBe('TYPE');
    expect(op.update.expressionValues[':voterId']?.S).toBe('sub-voter-9');
    expect(op.update.expressionValues[':value']?.S).toBe('SKYKING');
    expect(op.update.expressionValues[':fieldKey']?.S).toBe('msg-abc#TYPE#sub-voter-9');
  });

  it('derives voterId from ctx.identity.sub (sub-as-id, #259)', () => {
    const op = request(
      ctxFor({ messageId: 'msg-7', field: 'BODY', value: 'lorem' }, 'sub-voter-from-jwt'),
    );
    expect(op.update.expressionValues[':voterId']?.S).toBe('sub-voter-from-jwt');
    expect(op.key.fieldKey?.S).toBe('msg-7#BODY#sub-voter-from-jwt');
  });

  it('rejects an empty messageId argument (caller bug — fail fast)', () => {
    expect(() => request(ctxFor({ messageId: '', field: 'SENDER', value: 'X' }))).toThrow(
      /messageId/i,
    );
  });

  it('rejects a missing field argument (caller bug — fail fast)', () => {
    expect(() =>
      request(
        ctxFor({
          messageId: 'msg-1',
          // @ts-expect-error — runtime guard
          field: '',
          value: 'X',
        }),
      ),
    ).toThrow(/field/i);
  });

  it('rejects an empty value argument (no blank votes)', () => {
    expect(() => request(ctxFor({ messageId: 'msg-1', field: 'SENDER', value: '' }))).toThrow(
      /value/i,
    );
  });

  it('rejects an unauthenticated request (ctx.identity.sub missing)', () => {
    const ctx: CastFieldVoteContext = {
      arguments: { messageId: 'msg-1', field: 'SENDER', value: 'X' },
      identity: undefined,
    };
    expect(() => request(ctx)).toThrow(/identity/i);
  });

  it('records weightAtVoteTime as a numeric column on the upsert', () => {
    // weightAtVoteTime defaults to 1 on a fresh vote — the request resolver
    // pins it via if_not_exists so subsequent re-casts don't recompute the
    // snapshot. The proper Reputation lookup is deferred to a follow-up.
    const op = request(
      ctxFor({ messageId: 'msg-w', field: 'RECEIVER', value: 'A' }, 'sub-voter-w'),
    );
    expect(op.update.expression).toMatch(/#weightAtVoteTime = if_not_exists/);
    expect(op.update.expressionValues[':weightAtVoteTime']?.N).toBe('1');
  });
});

describe('castFieldVote response resolver', () => {
  it('returns the upserted row to the caller', () => {
    const row = {
      fieldKey: 'msg-1#SENDER#sub-voter-1',
      messageId: 'msg-1',
      field: 'SENDER',
      voterId: 'sub-voter-1',
      value: 'SKYKING',
      weightAtVoteTime: 1,
    };
    const result = response(
      ctxFor({ messageId: 'msg-1', field: 'SENDER', value: 'SKYKING' }, 'sub-voter-1', row),
    );
    expect(result).toEqual(row);
  });
});
