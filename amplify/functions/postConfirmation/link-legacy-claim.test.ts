import { describe, it, expect, vi } from 'vitest';
import {
  linkLegacyClaim,
  type LegacyClaimDeps,
  type LegacyUserRow,
  type TransactPkRewriteInput,
} from './link-legacy-claim';

/**
 * Tests for the User-row PK rewrite half of the legacy-claim flow
 * (sub-A of #16, tracked at #272). Verifies:
 *   - Atomic Put+Delete via the injected transactor.
 *   - `USER_CLAIM` AuditLog entry with before/after snapshots + claimId.
 *   - Idempotency on already-CLAIMED rows.
 *   - Transaction failure surfaces; no audit entry written.
 *   - claimedAt + claimStatus propagated.
 */

const TABLE = 'User-abc123-fakeenv';

function freshLegacyRow(overrides: Partial<LegacyUserRow> = {}): LegacyUserRow {
  return {
    cognitoSub: 'legacy:42',
    email: 'reclaim@example.com',
    preferredUsername: 'old-handle',
    displayName: 'Legacy User',
    legacyUserId: 42,
    legacyEmail: 'reclaim@example.com',
    claimStatus: 'PENDING_CLAIM',
    piiBlanked: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<LegacyClaimDeps> = {}): LegacyClaimDeps & {
  transactSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
} {
  const transactSpy = vi.fn(() => Promise.resolve());
  const auditSpy = vi.fn(() => Promise.resolve('audit-id-123'));
  const fixedNow = new Date('2026-05-16T22:00:00.000Z');
  return {
    transactSpy,
    auditSpy,
    tableName: TABLE,
    transact: transactSpy,
    audit: auditSpy,
    now: () => fixedNow,
    newClaimId: () => 'claim-id-fixed',
    ...overrides,
  };
}

describe('linkLegacyClaim — User-row PK rewrite (sub-A of #16, #272)', () => {
  it('atomically deletes legacy PK and puts the new row in one transact call', async () => {
    const deps = makeDeps();
    const legacy = freshLegacyRow();

    await linkLegacyClaim({
      legacyRow: legacy,
      realSub: 'cog-real-sub-aaa',
      deps,
    });

    expect(deps.transactSpy).toHaveBeenCalledOnce();
    const input = deps.transactSpy.mock.calls[0]?.[0] as TransactPkRewriteInput;
    expect(input.tableName).toBe(TABLE);
    expect(input.oldPk).toEqual({ cognitoSub: 'legacy:42' });
    expect(input.newRow.cognitoSub).toBe('cog-real-sub-aaa');
  });

  it('copies every column from the legacy row onto the new row', async () => {
    const deps = makeDeps();
    const legacy = freshLegacyRow({
      preferredUsername: 'carry-over',
      displayName: 'Carry Over',
      legacyUserId: 99,
      legacyEmail: 'carry@example.com',
    });

    await linkLegacyClaim({
      legacyRow: legacy,
      realSub: 'cog-real-sub-bbb',
      deps,
    });

    const input = deps.transactSpy.mock.calls[0]?.[0] as TransactPkRewriteInput;
    expect(input.newRow.preferredUsername).toBe('carry-over');
    expect(input.newRow.displayName).toBe('Carry Over');
    expect(input.newRow.legacyUserId).toBe(99);
    expect(input.newRow.legacyEmail).toBe('carry@example.com');
    expect(input.newRow.email).toBe('reclaim@example.com');
  });

  it('flips claimStatus to CLAIMED and stamps claimedAt = now()', async () => {
    const deps = makeDeps();
    const legacy = freshLegacyRow();

    await linkLegacyClaim({
      legacyRow: legacy,
      realSub: 'cog-real-sub-ccc',
      deps,
    });

    const input = deps.transactSpy.mock.calls[0]?.[0] as TransactPkRewriteInput;
    expect(input.newRow.claimStatus).toBe('CLAIMED');
    expect(input.newRow.claimedAt).toBe('2026-05-16T22:00:00.000Z');
  });

  it('writes a USER_CLAIM AuditLog with before/after snapshots + claimId', async () => {
    const deps = makeDeps();
    const legacy = freshLegacyRow();

    await linkLegacyClaim({
      legacyRow: legacy,
      realSub: 'cog-real-sub-ddd',
      deps,
      auditContext: {
        identity: { sub: 'cog-real-sub-ddd' },
        request: { headers: {} },
      },
    });

    expect(deps.auditSpy).toHaveBeenCalledOnce();
    const [ctx, opts] = deps.auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('USER_CLAIM');
    expect(opts.targetType).toBe('User');
    expect(opts.targetId).toBe('cog-real-sub-ddd');
    expect(opts.claimId).toBe('claim-id-fixed');

    const before = opts.before as Record<string, unknown>;
    const after = opts.after as Record<string, unknown>;
    expect(before.cognitoSub).toBe('legacy:42');
    expect(before.claimStatus).toBe('PENDING_CLAIM');
    expect(after.cognitoSub).toBe('cog-real-sub-ddd');
    expect(after.claimStatus).toBe('CLAIMED');

    expect(ctx).toMatchObject({ identity: { sub: 'cog-real-sub-ddd' } });
  });

  it('returns the rewritten row to the caller', async () => {
    const deps = makeDeps();
    const legacy = freshLegacyRow();

    const result = await linkLegacyClaim({
      legacyRow: legacy,
      realSub: 'cog-real-sub-eee',
      deps,
    });

    expect(result.cognitoSub).toBe('cog-real-sub-eee');
    expect(result.claimStatus).toBe('CLAIMED');
    expect(result.email).toBe('reclaim@example.com');
  });

  it('is idempotent: legacy row already CLAIMED → no transact, no audit, returns row', async () => {
    const deps = makeDeps();
    const alreadyClaimed = freshLegacyRow({
      cognitoSub: 'cog-real-sub-fff',
      claimStatus: 'CLAIMED',
      claimedAt: '2025-01-01T00:00:00.000Z',
    });

    const result = await linkLegacyClaim({
      legacyRow: alreadyClaimed,
      realSub: 'cog-real-sub-fff',
      deps,
    });

    expect(deps.transactSpy).not.toHaveBeenCalled();
    expect(deps.auditSpy).not.toHaveBeenCalled();
    expect(result.cognitoSub).toBe('cog-real-sub-fff');
    expect(result.claimedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('throws when the legacy row PK does not start with the `legacy:` namespace', async () => {
    // Guard against accidental misuse — the helper only operates on
    // pre-seeded placeholder rows. A real Cognito sub (UUIDv4) should
    // never end up here, and silently rewriting one would shred FKs.
    const deps = makeDeps();
    const notLegacy = freshLegacyRow({ cognitoSub: 'cog-real-sub-already' });

    await expect(
      linkLegacyClaim({
        legacyRow: notLegacy,
        realSub: 'cog-real-sub-target',
        deps,
      }),
    ).rejects.toThrow(/legacy:/);
    expect(deps.transactSpy).not.toHaveBeenCalled();
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });

  it('propagates transact failure without writing audit', async () => {
    const deps = makeDeps({
      transact: vi.fn(() => Promise.reject(new Error('TransactionCanceledException'))),
    });

    await expect(
      linkLegacyClaim({
        legacyRow: freshLegacyRow(),
        realSub: 'cog-real-sub-ggg',
        deps,
      }),
    ).rejects.toThrow(/TransactionCanceledException/);
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });

  it('does not require an auditContext — defaults to system actor (null sub)', async () => {
    const deps = makeDeps();

    await linkLegacyClaim({
      legacyRow: freshLegacyRow(),
      realSub: 'cog-real-sub-hhh',
      deps,
      // no auditContext
    });

    expect(deps.auditSpy).toHaveBeenCalledOnce();
    const [ctx] = deps.auditSpy.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(ctx).toMatchObject({ identity: null });
  });
});
