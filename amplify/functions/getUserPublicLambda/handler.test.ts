import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import { handler, __setDeps, __resetDeps, type GetUserPublicDeps, type UserRow } from './handler';

/**
 * Tests for the `getUserPublic` Lambda (#271).
 *
 * Behaviour matches the original JS resolver in
 * `amplify/data/models/resolvers/get-user-public.js` — GetItem on
 * User by `cognitoSub`, blank `email` / `preferredUsername` /
 * `displayName` when `piiBlanked` and caller is not admin.
 *
 * The move from `a.handler.custom` to `a.handler.function` is what
 * lets us re-enable `allow.guest()` on the query under the
 * identityPool default auth mode (Amplify Gen 2 rejects guest
 * authz on custom JS resolvers — see #271 for the rationale).
 */

function makeEvent(
  args: { cognitoSub: string },
  identity: { sub?: string | null; groups?: readonly string[] | null } | null | undefined = null,
): AppSyncResolverEvent<{ cognitoSub: string }> {
  return {
    arguments: args,
    identity: identity as AppSyncResolverEvent<{ cognitoSub: string }>['identity'],
    source: null,
    request: { headers: {}, domainName: null },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Query',
      fieldName: 'getUserPublic',
      variables: {},
    },
    prev: null,
    stash: {},
  };
}

function makeStubs(opts: { row?: UserRow | null } = {}): GetUserPublicDeps & {
  getSpy: ReturnType<typeof vi.fn>;
} {
  const getSpy = vi.fn(() => Promise.resolve(opts.row ?? null));
  return {
    getSpy,
    getUserByCognitoSub: getSpy,
  };
}

describe('getUserPublic Lambda (#271)', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('returns null when the User row does not exist', async () => {
    const deps = makeStubs({ row: null });
    __setDeps(deps);
    const event = makeEvent({ cognitoSub: 'missing' });
    const result = await handler(event, {} as Context, () => undefined);
    expect(result).toBeNull();
  });

  it('returns the raw row when piiBlanked=false (any caller)', async () => {
    const deps = makeStubs({
      row: {
        cognitoSub: 'sub-1',
        email: 'a@example.com',
        preferredUsername: 'alex',
        displayName: 'Alex',
        piiBlanked: false,
      },
    });
    __setDeps(deps);
    const event = makeEvent({ cognitoSub: 'sub-1' });
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    expect(result.email).toBe('a@example.com');
    expect(result.preferredUsername).toBe('alex');
    expect(result.displayName).toBe('Alex');
  });

  it('blanks email / preferredUsername / displayName for non-admin caller when piiBlanked=true', async () => {
    const deps = makeStubs({
      row: {
        cognitoSub: 'sub-2',
        email: 'b@example.com',
        preferredUsername: 'bob',
        displayName: 'Bob',
        piiBlanked: true,
      },
    });
    __setDeps(deps);
    const event = makeEvent({ cognitoSub: 'sub-2' });
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    expect(result.email).toBeNull();
    expect(result.preferredUsername).toBeNull();
    expect(result.displayName).toBeNull();
    expect(result.cognitoSub).toBe('sub-2'); // non-PII preserved
  });

  it('returns the raw blanked-but-retained row when admin caller hits piiBlanked=true', async () => {
    const deps = makeStubs({
      row: {
        cognitoSub: 'sub-3',
        email: 'c@example.com',
        preferredUsername: 'cara',
        displayName: 'Cara',
        piiBlanked: true,
      },
    });
    __setDeps(deps);
    const event = makeEvent({ cognitoSub: 'sub-3' }, { sub: 'admin-sub', groups: ['admin'] });
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    // Admin sees the un-filtered row — `email` etc still present so
    // the audit trail stays usable.
    expect(result.email).toBe('c@example.com');
    expect(result.preferredUsername).toBe('cara');
    expect(result.displayName).toBe('Cara');
  });

  it('treats a guest caller (identity null) the same as a non-admin authenticated caller', async () => {
    const deps = makeStubs({
      row: {
        cognitoSub: 'sub-g',
        email: 'g@example.com',
        piiBlanked: true,
      },
    });
    __setDeps(deps);
    const event = makeEvent({ cognitoSub: 'sub-g' }, null);
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    expect(result.email).toBeNull();
  });

  it('rejects an empty cognitoSub argument (caller bug, fail fast)', async () => {
    __setDeps(makeStubs());
    const event = makeEvent({ cognitoSub: '' });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/cognitoSub/);
  });

  it('passes the row through when piiBlanked is undefined (legacy / fresh row)', async () => {
    // Fresh signup rows have `piiBlanked` defaulted at the model
    // level, but a row that pre-dates the default (or any consumer
    // that projects the column away) lands here with the field
    // undefined. The handler must treat that as "not blanked" so
    // the public profile renders normally.
    const deps = makeStubs({
      row: {
        cognitoSub: 'sub-legacy',
        email: 'legacy@example.com',
        preferredUsername: 'leg',
        displayName: 'Legacy',
        // no piiBlanked at all
      },
    });
    __setDeps(deps);
    const event = makeEvent({ cognitoSub: 'sub-legacy' });
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    expect(result.email).toBe('legacy@example.com');
    expect(result.preferredUsername).toBe('leg');
    expect(result.displayName).toBe('Legacy');
  });

  it('rejects a missing identity.groups (still non-admin, but the lookup must not crash)', async () => {
    const deps = makeStubs({
      row: {
        cognitoSub: 'sub-x',
        email: 'x@example.com',
        piiBlanked: true,
      },
    });
    __setDeps(deps);
    const event = makeEvent({ cognitoSub: 'sub-x' }, { sub: 'auth-only', groups: null });
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    expect(result.email).toBeNull();
  });
});
