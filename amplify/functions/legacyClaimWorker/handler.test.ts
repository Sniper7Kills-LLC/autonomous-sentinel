import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type LegacyClaimWorkerEvent,
  type WorkerDeps,
} from './handler';

/**
 * Tests for `legacyClaimWorker` (sub-A of #16, #272).
 *
 * Worker is async-invoked by `postConfirmation` (InvocationType: Event)
 * so the user-visible sign-up flow does not block on the PK rewrite.
 * Worker responsibilities:
 *   - Re-look-up the legacy row by email (avoids trusting stale payload).
 *   - Call `linkLegacyClaim` to perform the atomic Put+Delete.
 *   - Surface failures via thrown error so Lambda's async-invoke
 *     retry policy + DLQ can take over (no silent swallow here —
 *     the user is not waiting, so loud failure is the right default).
 *   - Skip when the email lookup returns no legacy row (race: the
 *     row may have been claimed by a parallel signup).
 */

const TABLE = 'User-table-test';

interface UserRow {
  cognitoSub: string;
  email?: string | null;
  legacyEmail?: string | null;
  legacyUserId?: number | null;
  claimStatus?: string | null;
  [k: string]: unknown;
}

function makeStubDeps(opts: { rowsByEmail?: UserRow[]; transactErr?: Error } = {}): WorkerDeps & {
  listSpy: ReturnType<typeof vi.fn>;
  transactSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
  fanOutQuerySpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn(() => Promise.resolve({ data: opts.rowsByEmail ?? [], errors: undefined }));
  const transactSpy = vi.fn(() => {
    if (opts.transactErr) return Promise.reject(opts.transactErr);
    return Promise.resolve();
  });
  const auditSpy = vi.fn(() => Promise.resolve('audit-id-x'));
  // Fan-out stubs: default to empty queries so the worker invokes
  // the helper but no per-table writes happen. Specific worker tests
  // can override via __setDeps if they want to assert fan-out wiring.
  const fanOutQuerySpy = vi.fn(() => Promise.resolve({ items: [] }));
  return {
    listSpy,
    transactSpy,
    auditSpy,
    fanOutQuerySpy,
    tableName: TABLE,
    dataClient: {
      models: {
        User: {
          listUserByEmail: listSpy,
        },
      },
    },
    transact: transactSpy,
    audit: auditSpy,
    now: () => new Date('2026-05-16T22:30:00.000Z'),
    newClaimId: () => 'claim-id-w1',
    fanOut: {
      tableNames: {
        Sdr: 'Sdr-t',
        Comment: 'Comment-t',
        AbuseReport: 'AbuseReport-t',
        Donation: 'Donation-t',
        Recording: 'Recording-t',
        TranscriptRevision: 'TranscriptRevision-t',
        User: TABLE,
        FieldVote: 'FieldVote-t',
        RevisionVote: 'RevisionVote-t',
        Reputation: 'Reputation-t',
        NotificationPreference: 'NotificationPreference-t',
      },
      query: fanOutQuerySpy,
      transact: vi.fn(() => Promise.resolve()),
      audit: vi.fn(() => Promise.resolve('fanout-audit-id')),
    },
  };
}

const baseEvent: LegacyClaimWorkerEvent = {
  realSub: 'cog-real-sub-001',
  email: 'reclaim@example.com',
};

describe('legacyClaimWorker', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('re-looks-up the legacy row by email + invokes linkLegacyClaim transact', async () => {
    const deps = makeStubDeps({
      rowsByEmail: [
        {
          cognitoSub: 'legacy:42',
          email: null,
          legacyEmail: 'reclaim@example.com',
          legacyUserId: 42,
          claimStatus: 'PENDING_CLAIM',
        },
      ],
    });
    __setDeps(deps);

    await handler(baseEvent, {} as Context, () => undefined);

    expect(deps.listSpy).toHaveBeenCalledWith({ email: 'reclaim@example.com' });
    expect(deps.transactSpy).toHaveBeenCalledOnce();
    expect(deps.auditSpy).toHaveBeenCalledOnce();
    const [, opts] = deps.auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.action).toBe('USER_CLAIM');
    expect(opts.targetId).toBe('cog-real-sub-001');
  });

  it('skips quietly when the legacy row is no longer present (parallel-claim race)', async () => {
    const deps = makeStubDeps({ rowsByEmail: [] });
    __setDeps(deps);

    await handler(baseEvent, {} as Context, () => undefined);

    expect(deps.listSpy).toHaveBeenCalledOnce();
    expect(deps.transactSpy).not.toHaveBeenCalled();
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });

  it('skips when the lookup returns a row that is already CLAIMED (idempotency)', async () => {
    const deps = makeStubDeps({
      rowsByEmail: [
        {
          cognitoSub: 'cog-real-sub-001',
          email: 'reclaim@example.com',
          claimStatus: 'CLAIMED',
        },
      ],
    });
    __setDeps(deps);

    await handler(baseEvent, {} as Context, () => undefined);
    expect(deps.transactSpy).not.toHaveBeenCalled();
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });

  it('throws when the transact fails — Lambda async-retry / DLQ takes over', async () => {
    const deps = makeStubDeps({
      rowsByEmail: [
        {
          cognitoSub: 'legacy:9',
          email: null,
          legacyEmail: 'reclaim@example.com',
          legacyUserId: 9,
          claimStatus: 'PENDING_CLAIM',
        },
      ],
      transactErr: new Error('TransactionCanceledException'),
    });
    __setDeps(deps);

    await expect(handler(baseEvent, {} as Context, () => undefined)).rejects.toThrow(
      /TransactionCanceledException/,
    );
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });

  it('rejects an event missing realSub or email — caller bug, fail loudly', async () => {
    __setDeps(makeStubDeps());

    await expect(
      handler({ realSub: '', email: 'x' }, {} as Context, () => undefined),
    ).rejects.toThrow(/realSub/);

    await expect(
      handler({ realSub: 'x', email: '' }, {} as Context, () => undefined),
    ).rejects.toThrow(/email/);
  });
});
