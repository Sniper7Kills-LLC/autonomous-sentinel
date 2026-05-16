import { describe, it, expect } from 'vitest';
import { request, response, type IsSuppressedContext } from './is-suppressed.js';

/**
 * Resolver-behavior tests for `isSuppressed` (issue #249).
 *
 * The email-send Lambda calls this before fanning out a notification.
 * Acceptance criteria checked here:
 *   - returns true when a row exists for the email
 *   - returns false when no row exists (ctx.result is null)
 *   - rejects empty input
 */

function ctxFor(email: string, result?: unknown): IsSuppressedContext {
  return { arguments: { email }, result };
}

describe('isSuppressed request resolver', () => {
  it('issues a GetItem against the EmailSuppression table for the input email', () => {
    const op = request(ctxFor('bouncer@example.com'));
    expect(op.operation).toBe('GetItem');
    expect(op.key.email?.S).toBe('bouncer@example.com');
  });

  it('rejects an empty email argument', () => {
    expect(() => request(ctxFor(''))).toThrow(/email/i);
  });
});

describe('isSuppressed response resolver', () => {
  it('returns true when DDB found a row (after suppression)', () => {
    const found = response(ctxFor('bouncer@example.com', { email: 'bouncer@example.com' }));
    expect(found).toBe(true);
  });

  it('returns false when DDB returned no row (never suppressed)', () => {
    expect(response(ctxFor('clean@example.com', null))).toBe(false);
  });
});
