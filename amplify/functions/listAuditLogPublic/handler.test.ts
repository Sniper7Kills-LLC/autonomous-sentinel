import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  PUBLIC_AUDIT_ACTIONS,
  type AuditLogPublicDataClient,
  type AuditLogRow,
} from './handler';

/**
 * Lambda-resolver tests for the `listAuditLogPublic` custom query
 * (#38). Public read with a per-caller filter so visitors only see
 * entries relevant to them — content-mutation entries for everyone,
 * USER_* entries only when the caller is the actor or target,
 * admin/mod see everything unfiltered.
 */

function makeEvent(
  args: { targetType?: string; targetId?: string; limit?: number } = {},
  identity: { sub?: string | null; groups?: readonly string[] | null } | null | undefined = null,
): AppSyncResolverEvent<typeof args> {
  return {
    arguments: args,
    identity: identity as AppSyncResolverEvent<typeof args>['identity'],
    source: null,
    request: { headers: {}, domainName: null },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Query',
      fieldName: 'listAuditLogPublic',
      variables: {},
    },
    prev: null,
    stash: {},
  };
}

function makeStubs(rows: AuditLogRow[] = []): AuditLogPublicDataClient & {
  listSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn(({ targetType, targetId }: { targetType?: string; targetId?: string }) => {
    const filtered = rows.filter((r) => {
      if (targetType && r.targetType !== targetType) return false;
      if (targetId && r.targetId !== targetId) return false;
      return true;
    });
    return Promise.resolve({ items: filtered, nextToken: undefined });
  });
  return { listSpy, listByTargetTypeAndTargetId: listSpy };
}

describe('listAuditLogPublic — public-visible actions for all callers', () => {
  beforeEach(() => __resetDeps());

  it('returns content-mutation entries to a guest caller', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 'a-1',
        action: 'MESSAGE_DELETE',
        targetType: 'Message',
        targetId: 'm-1',
        actorId: 'admin-1',
      },
      {
        id: 'a-2',
        action: 'RECORDING_DELETE',
        targetType: 'Recording',
        targetId: 'r-1',
        actorId: 'admin-1',
      },
      {
        id: 'a-3',
        action: 'COMMENT_DELETE',
        targetType: 'Comment',
        targetId: 'c-1',
        actorId: 'mod-1',
      },
    ];
    __setDeps(makeStubs(rows));

    const result = await handler(
      makeEvent({ targetType: 'Message', targetId: 'm-1' }),
      {} as Context,
      () => undefined,
    );
    const items = result?.items ?? [];
    expect(items.map((r) => r.action)).toContain('MESSAGE_DELETE');
  });

  it('returns TRANSMITTER_CREATE / UPDATE / DELETE entries to anyone', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 't-1',
        action: 'TRANSMITTER_CREATE',
        targetType: 'Transmitter',
        targetId: 'tx-1',
        actorId: 'admin-1',
      },
    ];
    __setDeps(makeStubs(rows));
    const result = await handler(
      makeEvent({ targetType: 'Transmitter', targetId: 'tx-1' }),
      {} as Context,
      () => undefined,
    );
    expect((result?.items ?? []).length).toBe(1);
  });

  it('omits USER_BAN entries from a guest caller (private action)', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 'b-1',
        action: 'USER_BAN',
        targetType: 'User',
        targetId: 'cog-victim',
        actorId: 'admin-1',
      },
    ];
    __setDeps(makeStubs(rows));
    const result = await handler(
      makeEvent({ targetType: 'User', targetId: 'cog-victim' }, null),
      {} as Context,
      () => undefined,
    );
    expect(result?.items ?? []).toEqual([]);
  });

  it('omits USER_PII_BLANK entries from an unrelated authenticated caller', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 'p-1',
        action: 'USER_PII_BLANK',
        targetType: 'User',
        targetId: 'cog-someone-else',
        actorId: 'cog-someone-else',
      },
    ];
    __setDeps(makeStubs(rows));
    const result = await handler(
      makeEvent(
        { targetType: 'User', targetId: 'cog-someone-else' },
        {
          sub: 'cog-bystander',
          groups: [],
        },
      ),
      {} as Context,
      () => undefined,
    );
    expect(result?.items ?? []).toEqual([]);
  });
});

describe('listAuditLogPublic — USER_* entries for the actor / target', () => {
  beforeEach(() => __resetDeps());

  it('returns USER_BAN entry when the caller is the target of the ban', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 'b-self',
        action: 'USER_BAN',
        targetType: 'User',
        targetId: 'cog-me',
        actorId: 'admin-1',
      },
    ];
    __setDeps(makeStubs(rows));
    const result = await handler(
      makeEvent({ targetType: 'User', targetId: 'cog-me' }, { sub: 'cog-me', groups: [] }),
      {} as Context,
      () => undefined,
    );
    expect((result?.items ?? []).length).toBe(1);
  });

  it('returns USER_ROLE_CHANGE entry when the caller is the actor (mod promoting)', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 'rc-1',
        action: 'USER_ROLE_CHANGE',
        targetType: 'User',
        targetId: 'cog-promoted',
        actorId: 'cog-me',
      },
    ];
    __setDeps(makeStubs(rows));
    const result = await handler(
      makeEvent(
        { targetType: 'User', targetId: 'cog-promoted' },
        {
          sub: 'cog-me',
          groups: [],
        },
      ),
      {} as Context,
      () => undefined,
    );
    expect((result?.items ?? []).length).toBe(1);
  });
});

describe('listAuditLogPublic — admin / moderator see everything', () => {
  beforeEach(() => __resetDeps());

  it('admin caller sees USER_BAN entries for any user', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 'b-1',
        action: 'USER_BAN',
        targetType: 'User',
        targetId: 'cog-victim',
        actorId: 'admin-1',
      },
      {
        id: 'b-2',
        action: 'USER_PII_BLANK',
        targetType: 'User',
        targetId: 'cog-another',
        actorId: 'cog-another',
      },
    ];
    __setDeps(makeStubs(rows));
    const result = await handler(
      makeEvent(
        { targetType: 'User', targetId: 'cog-victim' },
        {
          sub: 'admin-1',
          groups: ['admin'],
        },
      ),
      {} as Context,
      () => undefined,
    );
    // Filter is by-target; admin sees all matching rows regardless of action.
    expect((result?.items ?? []).map((r) => r.action)).toContain('USER_BAN');
  });

  it('moderator caller sees USER_BAN entries (same elevated visibility as admin)', async () => {
    const rows: AuditLogRow[] = [
      {
        id: 'b-1',
        action: 'USER_BAN',
        targetType: 'User',
        targetId: 'cog-victim',
        actorId: 'admin-1',
      },
    ];
    __setDeps(makeStubs(rows));
    const result = await handler(
      makeEvent(
        { targetType: 'User', targetId: 'cog-victim' },
        {
          sub: 'mod-1',
          groups: ['moderator'],
        },
      ),
      {} as Context,
      () => undefined,
    );
    expect((result?.items ?? []).length).toBe(1);
  });
});

describe('listAuditLogPublic — input validation', () => {
  beforeEach(() => __resetDeps());

  it('rejects when both targetType and targetId are missing (would scan entire log)', async () => {
    __setDeps(makeStubs([]));
    await expect(handler(makeEvent({}), {} as Context, () => undefined)).rejects.toThrow(
      /targetType|targetId/i,
    );
  });

  it('rejects when only targetType is supplied (would return too much data)', async () => {
    __setDeps(makeStubs([]));
    await expect(
      handler(makeEvent({ targetType: 'User' }), {} as Context, () => undefined),
    ).rejects.toThrow(/targetId/i);
  });
});

describe('PUBLIC_AUDIT_ACTIONS constant (#38)', () => {
  it('includes all content-mutation actions', () => {
    expect(PUBLIC_AUDIT_ACTIONS).toContain('MESSAGE_DELETE');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('MESSAGE_RESTORE');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('MESSAGE_EDIT');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('RECORDING_DELETE');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('RECORDING_RESTORE');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('COMMENT_DELETE');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('TRANSMITTER_CREATE');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('TRANSMITTER_UPDATE');
    expect(PUBLIC_AUDIT_ACTIONS).toContain('TRANSMITTER_DELETE');
  });

  it('excludes user-target actions', () => {
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('USER_BAN');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('USER_PII_BLANK');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('USER_CLAIM');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('USER_CLAIM_FANOUT');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('USER_ROLE_CHANGE');
  });

  it('excludes internal / admin-only actions', () => {
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('BUDGET_THRESHOLD_UPDATE');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('REP_FORMULA_UPDATE');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('FIELDVOTE_ORPHAN_SWEEP');
    expect(PUBLIC_AUDIT_ACTIONS).not.toContain('CALLSIGN_MERGE');
  });
});
