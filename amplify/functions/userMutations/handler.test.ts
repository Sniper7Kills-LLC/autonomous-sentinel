import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import { handler, __setDeps } from './handler';

/**
 * Lambda-resolver tests for the `selfDelete` + `banUser` custom mutations
 * (issue #248).
 *
 * The handler is wired into AppSync via `a.handler.function(userMutations)`
 * and dispatches on `event.info.fieldName`. Each branch:
 *   - Loads the target User row (so the audit diff can capture `before`).
 *   - Mutates the row (PII-blank or ban-fields-set).
 *   - Emits an AuditLog entry via the cross-cutting `audit()` helper from
 *     #258 — explicitly NOT hand-rolled here.
 *
 * Tests use injected dependencies (`__setDeps`) so the assertion surface
 * stays the data the handler computes, not the Amplify Data client wire
 * format. The injected deps mirror the structural shapes consumed in
 * production.
 */

interface UserRow {
  cognitoSub: string;
  email?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  piiBlanked?: boolean | null;
  piiBlankedAt?: string | null;
  bannedAt?: string | null;
  bannedReason?: string | null;
  bannedById?: string | null;
  [k: string]: unknown;
}

function makeEvent(
  overrides: Partial<AppSyncResolverEvent<Record<string, unknown>>> & {
    fieldName?: string;
  } = {},
): AppSyncResolverEvent<Record<string, unknown>> {
  const { fieldName = 'selfDelete', ...rest } = overrides;
  const base: AppSyncResolverEvent<Record<string, unknown>> = {
    arguments: {},
    identity: {
      sub: 'cognito-sub-actor-123',
      issuer: 'https://cognito',
      username: 'actor',
      claims: {},
      sourceIp: ['203.0.113.1'],
      defaultAuthStrategy: 'ALLOW',
      groups: null,
    },
    source: null,
    request: {
      headers: { 'x-forwarded-for': '203.0.113.1', 'user-agent': 'TestAgent/1.0' },
      domainName: null,
    },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Mutation',
      fieldName,
      variables: {},
    },
    prev: null,
    stash: {},
  };
  return { ...base, ...rest };
}

describe('userMutations handler — dispatch', () => {
  beforeEach(() => {
    // Inject a stub data client so the unknown-fieldName branch never
    // tries to bootstrap the real Amplify client (which would warn
    // "Amplify has not been configured" in test output).
    __setDeps({
      dataClient: {
        models: {
          User: {
            get: vi.fn(),
            update: vi.fn(),
          },
          Sdr: {
            listSdrByOwnerId: vi.fn(),
            update: vi.fn(),
          },
        },
      },
      audit: vi.fn(),
    });
  });

  it('rejects an unknown fieldName', async () => {
    const event = makeEvent({ fieldName: 'doSomethingElse', arguments: {} });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/fieldName/i);
  });
});

interface SdrTestRow {
  id: string;
  name?: string | null;
  notes?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationGranularity?: 'EXACT' | 'CITY' | 'REGION' | null;
  ownerId?: string | null;
}

describe('userMutations handler — selfDelete', () => {
  let users: Map<string, UserRow>;
  let sdrs: Map<string, SdrTestRow>;
  let userUpdateSpy: ReturnType<typeof vi.fn>;
  let sdrListSpy: ReturnType<typeof vi.fn>;
  let sdrUpdateSpy: ReturnType<typeof vi.fn>;
  let auditSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    users = new Map<string, UserRow>([
      [
        'cognito-sub-actor-123',
        {
          cognitoSub: 'cognito-sub-actor-123',
          email: 'me@example.com',
          preferredUsername: 'my-handle',
          displayName: 'Me User',
          piiBlanked: false,
        },
      ],
    ]);
    sdrs = new Map<string, SdrTestRow>();

    userUpdateSpy = vi.fn((input: Partial<UserRow> & { cognitoSub: string }) => {
      const before = users.get(input.cognitoSub);
      const merged: UserRow = {
        ...(before ?? { cognitoSub: input.cognitoSub }),
        ...input,
      };
      users.set(input.cognitoSub, merged);
      return Promise.resolve({ data: merged, errors: undefined });
    });
    sdrListSpy = vi.fn(({ ownerId }: { ownerId: string }) =>
      Promise.resolve({
        data: Array.from(sdrs.values()).filter((s) => s.ownerId === ownerId),
        errors: undefined,
      }),
    );
    sdrUpdateSpy = vi.fn((input: Partial<SdrTestRow> & { id: string }) => {
      const before = sdrs.get(input.id);
      const merged: SdrTestRow = { ...(before ?? { id: input.id }), ...input };
      sdrs.set(input.id, merged);
      return Promise.resolve({ data: merged, errors: undefined });
    });
    auditSpy = vi.fn(() => Promise.resolve('audit-id-1'));

    __setDeps({
      dataClient: {
        models: {
          User: {
            get: vi.fn((input: { cognitoSub: string }) =>
              Promise.resolve({
                data: users.get(input.cognitoSub) ?? null,
                errors: undefined,
              }),
            ),
            update: userUpdateSpy,
          },
          Sdr: {
            listSdrByOwnerId: sdrListSpy,
            update: sdrUpdateSpy,
          },
        },
      },
      audit: auditSpy,
    });
  });

  it('blanks email / preferredUsername / displayName on the row keyed by ctx.identity.sub', async () => {
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    await handler(event, {} as Context, () => undefined);

    expect(userUpdateSpy).toHaveBeenCalledOnce();
    const patch = userUpdateSpy.mock.calls[0]?.[0] as UserRow;
    expect(patch.cognitoSub).toBe('cognito-sub-actor-123');
    expect(patch.email).toBeNull();
    expect(patch.preferredUsername).toBeNull();
    expect(patch.displayName).toBeNull();
  });

  it('sets piiBlanked=true and piiBlankedAt to a current ISO timestamp', async () => {
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    await handler(event, {} as Context, () => undefined);

    const patch = userUpdateSpy.mock.calls[0]?.[0] as UserRow;
    expect(patch.piiBlanked).toBe(true);
    expect(patch.piiBlankedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('writes a USER_PII_BLANK AuditLog entry with before + after snapshots', async () => {
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    await handler(event, {} as Context, () => undefined);

    expect(auditSpy).toHaveBeenCalledOnce();
    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('USER_PII_BLANK');
    expect(opts.targetType).toBe('User');
    expect(opts.targetId).toBe('cognito-sub-actor-123');

    const before = opts.before as UserRow;
    expect(before.email).toBe('me@example.com');
    expect(before.preferredUsername).toBe('my-handle');
    expect(before.displayName).toBe('Me User');

    const after = opts.after as UserRow;
    expect(after.email).toBeNull();
    expect(after.piiBlanked).toBe(true);
  });

  it('passes the request context through to audit (ip + user-agent travel along)', async () => {
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    await handler(event, {} as Context, () => undefined);

    const [auditCtx] = auditSpy.mock.calls[0] as [
      { identity?: { sub?: string }; request?: { headers?: Record<string, string> } },
      unknown,
    ];
    expect(auditCtx.identity?.sub).toBe('cognito-sub-actor-123');
    expect(auditCtx.request?.headers?.['x-forwarded-for']).toBe('203.0.113.1');
    expect(auditCtx.request?.headers?.['user-agent']).toBe('TestAgent/1.0');
  });

  it('rejects unauthenticated callers (no identity.sub)', async () => {
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    event.identity = null;
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/identity/i);
    expect(userUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('returns the updated User row to the caller', async () => {
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    expect(result.cognitoSub).toBe('cognito-sub-actor-123');
    expect(result.email).toBeNull();
    expect(result.piiBlanked).toBe(true);
  });

  it('throws if the target row does not exist (cannot self-delete a phantom)', async () => {
    users.clear();
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not found/i);
    expect(userUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('preserves cognitoSub (the FK target for Recording / Comment / Donation) — submissions stay queryable', async () => {
    // Acceptance criterion #248: "Self-delete leaves Recording / Comment
    // / Donation rows intact and queryable." Those rows hold `uploaderId`
    // / `authorId` / `userId` FKs pointing at User.cognitoSub. As long
    // as cognitoSub is preserved through the blank, the rows continue to
    // resolve their User-side ref via the existing GSI lookup.
    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    await handler(event, {} as Context, () => undefined);

    const patch = userUpdateSpy.mock.calls[0]?.[0] as UserRow;
    // The patch ONLY touches PII + lifecycle fields — no FK column ever
    // appears here, so no FK can be invalidated by the operation.
    expect(patch.cognitoSub).toBe('cognito-sub-actor-123');
    expect(Object.keys(patch).sort()).toEqual(
      [
        'cognitoSub',
        'displayName',
        'email',
        'piiBlanked',
        'piiBlankedAt',
        'preferredUsername',
      ].sort(),
    );
  });

  it('is idempotent: a second self-delete on a row that is already piiBlanked is a no-op', async () => {
    users.set('cognito-sub-actor-123', {
      cognitoSub: 'cognito-sub-actor-123',
      email: null,
      preferredUsername: null,
      displayName: null,
      piiBlanked: true,
      piiBlankedAt: '2026-05-15T00:00:00.000Z',
    });

    const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
    await handler(event, {} as Context, () => undefined);

    // No further update, no further audit row — the row is already blanked.
    expect(userUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    // And no cascade probe either; the early-return short-circuits
    // before the Sdr fan-out runs.
    expect(sdrListSpy).not.toHaveBeenCalled();
  });

  describe('selfDelete cascade to owned Sdrs (#286)', () => {
    beforeEach(() => {
      sdrs.set('sdr-exact', {
        id: 'sdr-exact',
        name: 'My Home SDR',
        notes: 'rooftop antenna',
        latitude: 37.774929,
        longitude: -122.419416,
        locationGranularity: 'EXACT',
        ownerId: 'cognito-sub-actor-123',
      });
      sdrs.set('sdr-city', {
        id: 'sdr-city',
        name: 'My Office SDR',
        notes: 'desk',
        latitude: 40.7128,
        longitude: -74.006,
        locationGranularity: 'CITY',
        ownerId: 'cognito-sub-actor-123',
      });
      sdrs.set('sdr-other-owner', {
        id: 'sdr-other-owner',
        name: 'Not Mine',
        notes: 'someone else',
        locationGranularity: 'EXACT',
        ownerId: 'different-owner',
      });
    });

    it('queries the ownerId GSI with the caller sub', async () => {
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      expect(sdrListSpy).toHaveBeenCalledOnce();
      expect(sdrListSpy.mock.calls[0]?.[0]).toEqual({ ownerId: 'cognito-sub-actor-123' });
    });

    it('blanks name + notes on every owned Sdr', async () => {
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      const patches = sdrUpdateSpy.mock.calls.map((c) => c[0] as SdrTestRow);
      const byId = new Map(patches.map((p) => [p.id, p]));
      expect(byId.get('sdr-exact')?.name).toBe('[deleted]');
      expect(byId.get('sdr-exact')?.notes).toBeNull();
      expect(byId.get('sdr-city')?.name).toBe('[deleted]');
      expect(byId.get('sdr-city')?.notes).toBeNull();
    });

    it('nulls lat/lon only for granularity=EXACT Sdrs (CITY/REGION already blurred at display)', async () => {
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      const patches = sdrUpdateSpy.mock.calls.map((c) => c[0] as SdrTestRow);
      const byId = new Map(patches.map((p) => [p.id, p]));
      expect(byId.get('sdr-exact')?.latitude).toBeNull();
      expect(byId.get('sdr-exact')?.longitude).toBeNull();
      // CITY granularity: lat/lon NOT touched (listSdrPublic blurs to 1 dp).
      expect(byId.get('sdr-city')?.latitude).toBeUndefined();
      expect(byId.get('sdr-city')?.longitude).toBeUndefined();
    });

    it('does not touch Sdrs owned by other users', async () => {
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      const patchedIds = sdrUpdateSpy.mock.calls.map((c) => (c[0] as SdrTestRow).id);
      expect(patchedIds).not.toContain('sdr-other-owner');
      // sdrs map should still hold the other owner's row unchanged.
      expect(sdrs.get('sdr-other-owner')?.name).toBe('Not Mine');
    });

    it('emits one SDR_PII_BLANK audit per Sdr (targetType=Sdr)', async () => {
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      const auditCalls = auditSpy.mock.calls.map((c) => c[1] as Record<string, unknown>);
      const sdrAudits = auditCalls.filter((a) => a.targetType === 'Sdr');
      expect(sdrAudits).toHaveLength(2);
      const auditedIds = sdrAudits.map((a) => a.targetId as string).sort();
      expect(auditedIds).toEqual(['sdr-city', 'sdr-exact']);
      for (const a of sdrAudits) {
        expect(a.action).toBe('SDR_PII_BLANK');
      }
    });

    it('audit before/after snapshots capture the wiped fields', async () => {
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      const auditCalls = auditSpy.mock.calls.map((c) => c[1] as Record<string, unknown>);
      const exactAudit = auditCalls.find(
        (a) => a.targetType === 'Sdr' && a.targetId === 'sdr-exact',
      );
      expect(exactAudit).toBeDefined();
      const before = exactAudit?.before as SdrTestRow;
      const after = exactAudit?.after as SdrTestRow;
      expect(before.name).toBe('My Home SDR');
      expect(before.latitude).toBe(37.774929);
      expect(after.name).toBe('[deleted]');
      expect(after.latitude).toBeNull();
    });

    it('runs the User blank + Sdr cascade in order (User audit first, then Sdr audits)', async () => {
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      // The User audit lands first; Sdr audits follow.
      const targetTypes = auditSpy.mock.calls.map(
        (c) => (c[1] as Record<string, unknown>).targetType,
      );
      expect(targetTypes[0]).toBe('User');
      expect(targetTypes.slice(1).every((t) => t === 'Sdr')).toBe(true);
    });

    it('completes even when an individual Sdr update returns an error (cascade does not roll back the User blank)', async () => {
      // Make the first Sdr.update call fail (sdr-exact iterated first
      // because the fan-out preserves Map insertion order); the second
      // call (sdr-city) succeeds. Asserting the specific surviving id
      // is what makes this test catch a regression where the cascade
      // bails out on the first error instead of continuing.
      sdrUpdateSpy.mockImplementationOnce(() =>
        Promise.resolve({ data: null, errors: [{ message: 'boom' }] }),
      );

      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      const result = (await handler(event, {} as Context, () => undefined)) as UserRow;

      // User row is still blanked.
      expect(result.piiBlanked).toBe(true);
      const sdrAudits = auditSpy.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .filter((a) => a.targetType === 'Sdr');
      // The failing sdr-exact emitted no audit; sdr-city did.
      const auditedIds = sdrAudits.map((a) => a.targetId as string).sort();
      expect(auditedIds).toEqual(['sdr-city']);
      // Both Sdr updates were attempted (cascade did not bail).
      expect(sdrUpdateSpy).toHaveBeenCalledTimes(2);
    });

    it('skips the cascade entirely on idempotent re-call (already-blanked User)', async () => {
      users.set('cognito-sub-actor-123', {
        cognitoSub: 'cognito-sub-actor-123',
        email: null,
        preferredUsername: null,
        displayName: null,
        piiBlanked: true,
        piiBlankedAt: '2026-05-15T00:00:00.000Z',
      });

      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      // The early-return short-circuits the cascade. Acceptable trade-off
      // for v1: a partial cascade from a prior selfDelete (some Sdr
      // updates failed) is recovered by a janitor sweep follow-up, not by
      // a second user call. Replaying the cascade here would re-emit
      // SDR_PII_BLANK audits for already-blanked rows, polluting the
      // audit log. The janitor will be the dedicated recovery path.
      expect(sdrListSpy).not.toHaveBeenCalled();
      expect(sdrUpdateSpy).not.toHaveBeenCalled();
    });

    it('cascade is a no-op when the user owns zero Sdrs', async () => {
      sdrs.clear();
      const event = makeEvent({ fieldName: 'selfDelete', arguments: {} });
      await handler(event, {} as Context, () => undefined);

      expect(sdrListSpy).toHaveBeenCalledOnce();
      expect(sdrUpdateSpy).not.toHaveBeenCalled();
      // Only the User audit fires.
      const auditCalls = auditSpy.mock.calls.map((c) => c[1] as Record<string, unknown>);
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0]?.targetType).toBe('User');
    });
  });
});

describe('userMutations handler — banUser', () => {
  let users: Map<string, UserRow>;
  let userUpdateSpy: ReturnType<typeof vi.fn>;
  let auditSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    users = new Map<string, UserRow>([
      [
        'target-sub-456',
        {
          cognitoSub: 'target-sub-456',
          email: 'target@example.com',
          displayName: 'Target',
        },
      ],
    ]);

    userUpdateSpy = vi.fn((input: Partial<UserRow> & { cognitoSub: string }) => {
      const before = users.get(input.cognitoSub);
      const merged: UserRow = {
        ...(before ?? { cognitoSub: input.cognitoSub }),
        ...input,
      };
      users.set(input.cognitoSub, merged);
      return Promise.resolve({ data: merged, errors: undefined });
    });
    auditSpy = vi.fn(() => Promise.resolve('audit-id-2'));

    __setDeps({
      dataClient: {
        models: {
          User: {
            get: vi.fn((input: { cognitoSub: string }) =>
              Promise.resolve({
                data: users.get(input.cognitoSub) ?? null,
                errors: undefined,
              }),
            ),
            update: userUpdateSpy,
          },
          Sdr: {
            listSdrByOwnerId: vi.fn(() => Promise.resolve({ data: [], errors: undefined })),
            update: vi.fn(),
          },
        },
      },
      audit: auditSpy,
    });
  });

  it('rejects callers who are not in the admin group', async () => {
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { targetCognitoSub: 'target-sub-456', reason: 'spam' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['member'];
    }
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/admin/i);
    expect(userUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('rejects callers with no identity entirely', async () => {
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { targetCognitoSub: 'target-sub-456', reason: 'spam' },
    });
    event.identity = null;
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow();
    expect(userUpdateSpy).not.toHaveBeenCalled();
  });

  it('sets bannedAt / bannedReason / bannedById on the target row', async () => {
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { targetCognitoSub: 'target-sub-456', reason: 'repeated abuse' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    const patch = userUpdateSpy.mock.calls[0]?.[0] as UserRow;
    expect(patch.cognitoSub).toBe('target-sub-456');
    expect(patch.bannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(patch.bannedReason).toBe('repeated abuse');
    expect(patch.bannedById).toBe('cognito-sub-actor-123');
  });

  it('writes a USER_BAN AuditLog with reason + before/after snapshots', async () => {
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { targetCognitoSub: 'target-sub-456', reason: 'repeated abuse' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('USER_BAN');
    expect(opts.targetType).toBe('User');
    expect(opts.targetId).toBe('target-sub-456');
    expect(opts.reason).toBe('repeated abuse');

    const before = opts.before as UserRow;
    expect(before.bannedAt).toBeFalsy();
    const after = opts.after as UserRow;
    expect(after.bannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(after.bannedReason).toBe('repeated abuse');
    expect(after.bannedById).toBe('cognito-sub-actor-123');
  });

  it('represents an empty reason as null on both the row and the audit (review fix — #248)', async () => {
    // Reviewer flagged that the row column wrote `null` for an empty
    // reason while the audit helper got `undefined` (omitted). Both
    // values land in DDB as `null` via the helper's `?? null`, but the
    // call-site asymmetry would make any future "bans with no reason"
    // predicate diverge if the audit shape changed. Both branches now
    // pass the same `null` so the contract is explicit.
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { targetCognitoSub: 'target-sub-456', reason: '' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await handler(event, {} as Context, () => undefined);

    const patch = userUpdateSpy.mock.calls[0]?.[0] as UserRow;
    expect(patch.bannedReason).toBeNull();

    const [, opts] = auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.reason).toBeNull();
  });

  it('throws when targetCognitoSub argument is missing', async () => {
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { reason: 'something' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(
      /targetCognitoSub/,
    );
  });

  it('throws when the target row does not exist', async () => {
    users.clear();
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { targetCognitoSub: 'no-such-user', reason: 'spam' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not found/i);
    expect(userUpdateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('returns the banned User row to the caller', async () => {
    const event = makeEvent({
      fieldName: 'banUser',
      arguments: { targetCognitoSub: 'target-sub-456', reason: 'spam' },
    });
    if (event.identity && 'groups' in event.identity) {
      event.identity.groups = ['admin'];
    }
    const result = (await handler(event, {} as Context, () => undefined)) as UserRow;
    expect(result.cognitoSub).toBe('target-sub-456');
    expect(result.bannedReason).toBe('spam');
    expect(result.bannedById).toBe('cognito-sub-actor-123');
  });
});
