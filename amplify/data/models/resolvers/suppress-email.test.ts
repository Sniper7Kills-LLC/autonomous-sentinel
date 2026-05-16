import { describe, it, expect } from 'vitest';
import {
  request,
  response,
  type SuppressEmailArgs,
  type SuppressEmailContext,
  type UpdateItemOperation,
} from './suppress-email.js';

/**
 * Resolver-behavior tests for `suppressEmail` (issue #249).
 *
 * Acceptance criteria checked here:
 *   - Hard bounce immediately writes the row (occurrences ADD 1, reason locked).
 *   - Repeated soft bounce increments `occurrences` + refreshes `lastSeenAt`.
 *   - Manual entry (admin opt-out) writes a MANUAL row.
 *
 * AppSync JS resolvers are pure functions: `request(ctx)` returns a DDB
 * operation descriptor; `response(ctx)` shapes the GraphQL response from
 * `ctx.result`. We exercise both directly with mock contexts — no AWS
 * round-trip needed for unit coverage.
 */

function ctxFor(args: SuppressEmailArgs, result?: Record<string, unknown>): SuppressEmailContext {
  return { arguments: args, result };
}

describe('suppressEmail request resolver', () => {
  it('writes a HARD_BOUNCE row with occurrences=1 and matching timestamps', () => {
    const op: UpdateItemOperation = request(
      ctxFor({
        email: 'bouncer@example.com',
        reason: 'HARD_BOUNCE',
        bounceType: 'Permanent/General',
      }),
    );

    expect(op.operation).toBe('UpdateItem');
    expect(op.key.email?.S).toBe('bouncer@example.com');

    // Update expression must atomically:
    //   1. set reason / bounceType
    //   2. set firstSeenAt if missing (if_not_exists)
    //   3. refresh lastSeenAt
    //   4. increment occurrences (start at 1)
    const upd = op.update.expression;
    expect(upd).toMatch(/SET .*#reason = :reason/);
    expect(upd).toMatch(/#firstSeenAt = if_not_exists/);
    expect(upd).toMatch(/#lastSeenAt = :now/);
    expect(upd).toMatch(/ADD #occurrences :one/);
    expect(op.update.expressionValues[':one']?.N).toBe('1');
    expect(op.update.expressionValues[':reason']?.S).toBe('HARD_BOUNCE');
  });

  it('refreshes lastSeenAt and increments occurrences on repeated soft bounce', () => {
    const op = request(
      ctxFor({
        email: 'flaky@example.com',
        reason: 'SOFT_BOUNCE_REPEATED',
      }),
    );

    expect(op.operation).toBe('UpdateItem');
    // ADD #occurrences :one is what makes repeated calls count up
    expect(op.update.expression).toMatch(/ADD #occurrences :one/);
    // lastSeenAt must always be refreshed
    const now = op.update.expressionValues[':now'];
    expect(now).toBeDefined();
    expect(now?.S).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('accepts MANUAL reason for admin opt-out entries', () => {
    const op = request(
      ctxFor({
        email: 'optout@example.com',
        reason: 'MANUAL',
        notes: 'user emailed support requesting suppression',
      }),
    );

    expect(op.operation).toBe('UpdateItem');
    expect(op.update.expressionValues[':reason']?.S).toBe('MANUAL');
    expect(op.update.expressionValues[':notes']?.S).toBe(
      'user emailed support requesting suppression',
    );
    // Manual entries (admin opt-out) still count as occurrences so repeated
    // re-suppression doesn't silently overwrite history. PR #263 review gap.
    expect(op.update.expression).toMatch(/ADD #occurrences :one/);
  });

  it('omits bounceType / notes from the update when not supplied', () => {
    const op = request(ctxFor({ email: 'minimal@example.com', reason: 'COMPLAINT' }));
    // No :bounceType / :notes value bindings means SET clause skipped those
    expect(op.update.expressionValues[':bounceType']).toBeUndefined();
    expect(op.update.expressionValues[':notes']).toBeUndefined();
    expect(op.update.expression).not.toMatch(/#bounceType =/);
    expect(op.update.expression).not.toMatch(/#notes =/);
  });

  it('rejects an empty email argument (caller bug — fail fast)', () => {
    expect(() => request(ctxFor({ email: '', reason: 'HARD_BOUNCE' }))).toThrow(/email/i);
  });
});

describe('suppressEmail response resolver', () => {
  it('returns the written row to the caller', () => {
    const row = {
      email: 'bouncer@example.com',
      reason: 'HARD_BOUNCE',
      occurrences: 3,
      firstSeenAt: '2026-05-01T00:00:00.000Z',
      lastSeenAt: '2026-05-16T12:00:00.000Z',
    };
    const result = response(ctxFor({ email: 'bouncer@example.com', reason: 'HARD_BOUNCE' }, row));
    expect(result).toEqual(row);
  });
});
