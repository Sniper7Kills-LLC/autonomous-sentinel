import { describe, it, expect } from 'vitest';
import {
  request,
  response,
  type GetUserPublicContext,
  type UserRowFromDdb,
} from './get-user-public.js';

/**
 * Resolver-behavior tests for `getUserPublic` (issue #248).
 *
 * The PII filter is the heart of CLAUDE.md's "row retained, PII blanked"
 * self-deletion contract. Guest + authenticated callers must see null
 * email / displayName / preferredUsername whenever `piiBlanked=true`;
 * admins still see the blanked-but-retained values via the audit trail
 * (admin reads route through the direct `getUser` model resolver, not
 * this wrapper).
 *
 * AppSync JS resolvers are pure functions: `request(ctx)` returns a DDB
 * operation; `response(ctx)` shapes the response from `ctx.result`. The
 * resolver is deliberately tolerant of missing identity (guest reads) —
 * absence of `cognito:groups` falls through to the non-admin branch.
 */

function ctxFor(
  cognitoSub: string,
  result?: UserRowFromDdb | null,
  identity?: GetUserPublicContext['identity'],
): GetUserPublicContext {
  return { arguments: { cognitoSub }, result, identity };
}

describe('getUserPublic request resolver', () => {
  it('issues a GetItem against the User table for the supplied cognitoSub', () => {
    const op = request(ctxFor('cognito-sub-123'));
    expect(op.operation).toBe('GetItem');
    expect(op.key.cognitoSub?.S).toBe('cognito-sub-123');
  });

  it('rejects an empty cognitoSub argument', () => {
    expect(() => request(ctxFor(''))).toThrow(/cognitoSub/i);
  });
});

describe('getUserPublic response resolver — PII filter', () => {
  const blankedRow: UserRowFromDdb = {
    cognitoSub: 'sub-blanked',
    email: 'still-on-the-row@example.com',
    preferredUsername: 'PreservedHandle',
    displayName: 'Will G',
    role: 'member',
    piiBlanked: true,
    piiBlankedAt: '2026-05-16T12:00:00.000Z',
  };

  it('returns null PII fields to guest callers when piiBlanked=true', () => {
    const out = response(ctxFor('sub-blanked', blankedRow, null));
    expect(out).not.toBeNull();
    expect(out?.email).toBeNull();
    expect(out?.preferredUsername).toBeNull();
    expect(out?.displayName).toBeNull();
  });

  it('returns null PII fields to non-admin authenticated callers when piiBlanked=true', () => {
    const out = response(
      ctxFor('sub-blanked', blankedRow, { sub: 'some-other-user', groups: ['member'] }),
    );
    expect(out?.email).toBeNull();
    expect(out?.preferredUsername).toBeNull();
    expect(out?.displayName).toBeNull();
  });

  it('returns null PII fields to moderator callers when piiBlanked=true (only admin sees PII)', () => {
    const out = response(
      ctxFor('sub-blanked', blankedRow, { sub: 'mod-1', groups: ['moderator'] }),
    );
    expect(out?.email).toBeNull();
    expect(out?.preferredUsername).toBeNull();
    expect(out?.displayName).toBeNull();
  });

  it('returns the raw PII values to admin callers even when piiBlanked=true', () => {
    const out = response(ctxFor('sub-blanked', blankedRow, { sub: 'admin-1', groups: ['admin'] }));
    expect(out?.email).toBe('still-on-the-row@example.com');
    expect(out?.preferredUsername).toBe('PreservedHandle');
    expect(out?.displayName).toBe('Will G');
  });

  it('preserves non-PII fields (role, piiBlanked, piiBlankedAt) for all callers', () => {
    const out = response(ctxFor('sub-blanked', blankedRow, null));
    expect(out?.role).toBe('member');
    expect(out?.piiBlanked).toBe(true);
    expect(out?.piiBlankedAt).toBe('2026-05-16T12:00:00.000Z');
    expect(out?.cognitoSub).toBe('sub-blanked');
  });

  it('passes through PII fields unfiltered when piiBlanked is false', () => {
    const liveRow: UserRowFromDdb = {
      cognitoSub: 'sub-live',
      email: 'live@example.com',
      preferredUsername: 'live-user',
      displayName: 'Live User',
      piiBlanked: false,
    };
    const out = response(ctxFor('sub-live', liveRow, null));
    expect(out?.email).toBe('live@example.com');
    expect(out?.preferredUsername).toBe('live-user');
    expect(out?.displayName).toBe('Live User');
  });

  it('passes through PII fields unfiltered when piiBlanked is missing (legacy / fresh row)', () => {
    const legacyRow: UserRowFromDdb = {
      cognitoSub: 'legacy:42',
      email: 'legacy@example.com',
      preferredUsername: 'legacyuser',
      displayName: 'Legacy User',
    };
    const out = response(ctxFor('legacy:42', legacyRow, null));
    expect(out?.email).toBe('legacy@example.com');
  });

  it('returns null when DDB found no row', () => {
    expect(response(ctxFor('missing-sub', null, null))).toBeNull();
  });

  it('returns null when DDB returned undefined', () => {
    expect(response(ctxFor('missing-sub'))).toBeNull();
  });

  it('treats identity with no groups property as non-admin', () => {
    const out = response(ctxFor('sub-blanked', blankedRow, { sub: 'x' }));
    expect(out?.email).toBeNull();
  });

  it('admin group detection is case-sensitive (defense-in-depth)', () => {
    const out = response(ctxFor('sub-blanked', blankedRow, { groups: ['Admin', 'ADMIN'] }));
    expect(out?.email).toBeNull();
  });
});
