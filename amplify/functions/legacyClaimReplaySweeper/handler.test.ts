import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type SweeperDeps,
  type ClaimedUserRow,
  type AuditEntry,
} from './handler';

/**
 * Tests for the legacy-claim replay sweeper (sub-C of #16, #274).
 *
 * The sweeper runs on an EventBridge daily schedule. For every User
 * row with `claimStatus = CLAIMED`, it groups USER_CLAIM_FANOUT
 * audit entries by `claimId`, builds the per-claim completed-tables
 * set, and re-runs `fanOutLegacyFks` with the manifest-skip hook so
 * only tables that were never fanned out get re-queried. The User
 * row already exists (PR A finished); this PR only catches dropped
 * fan-out work from PR B failing mid-flight.
 */

const NEW_SUB_A = 'cog-real-sub-aaa';
const NEW_SUB_B = 'cog-real-sub-bbb';

function makeDeps(
  opts: {
    claimedUsers?: ClaimedUserRow[];
    auditByTarget?: Record<string, AuditEntry[]>;
  } = {},
): SweeperDeps & {
  listClaimedSpy: ReturnType<typeof vi.fn>;
  listAuditSpy: ReturnType<typeof vi.fn>;
  fanOutSpy: ReturnType<typeof vi.fn>;
} {
  const listClaimedSpy = vi.fn(() => Promise.resolve({ items: opts.claimedUsers ?? [] }));
  const listAuditSpy = vi.fn(({ targetId }: { targetId: string }) =>
    Promise.resolve({ items: opts.auditByTarget?.[targetId] ?? [] }),
  );
  const fanOutSpy = vi.fn(() =>
    Promise.resolve({
      Sdr: 0,
      Comment: 0,
      AbuseReport: 0,
      Donation: 0,
      Recording: 0,
      TranscriptRevision: 0,
      User: 0,
      Message: 0,
      FieldVote: 0,
      RevisionVote: 0,
      Reputation: 0,
      NotificationPreference: 0,
    }),
  );
  return {
    listClaimedSpy,
    listAuditSpy,
    fanOutSpy,
    listClaimedUsers: listClaimedSpy,
    listAuditForTarget: listAuditSpy,
    runFanOut: fanOutSpy,
  };
}

const event = {} as ScheduledEvent;
const context = {} as Context;

describe('legacyClaimReplaySweeper', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('no-op when there are no CLAIMED users', async () => {
    const deps = makeDeps({ claimedUsers: [] });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.listClaimedSpy).toHaveBeenCalledOnce();
    expect(deps.fanOutSpy).not.toHaveBeenCalled();
  });

  it('skips a fully-done claim — audit manifest lists every fan-out table', async () => {
    const allTables = [
      'Sdr',
      'Comment',
      'AbuseReport',
      'Donation',
      'Recording',
      'TranscriptRevision',
      'User',
      'Message',
      'FieldVote',
      'RevisionVote',
      'Reputation',
      'NotificationPreference',
    ];
    const deps = makeDeps({
      claimedUsers: [
        {
          cognitoSub: NEW_SUB_A,
          email: 'a@example.com',
          legacyEmail: 'a@example.com',
          legacyUserId: 11,
          claimStatus: 'CLAIMED',
        },
      ],
      auditByTarget: {
        [NEW_SUB_A]: [
          { action: 'USER_CLAIM', claimId: 'claim-a' },
          ...allTables.map((t) => ({
            action: 'USER_CLAIM_FANOUT' as const,
            claimId: 'claim-a',
            after: { table: t },
          })),
        ],
      },
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    // fan-out still invoked (the helper is the one that does the skip
    // via getCompletedTables) but the manifest-skip set should be the
    // full table list, so the helper itself does no work.
    expect(deps.fanOutSpy).toHaveBeenCalledOnce();
    const args = deps.fanOutSpy.mock.calls[0]?.[0] as {
      deps: { getCompletedTables: (claimId: string) => Promise<ReadonlySet<string>> };
    };
    const completed = await args.deps.getCompletedTables('claim-a');
    expect(completed.size).toBe(12);
  });

  it('re-runs fan-out for tables missing from the manifest (partial-state)', async () => {
    const deps = makeDeps({
      claimedUsers: [
        {
          cognitoSub: NEW_SUB_A,
          email: 'a@example.com',
          legacyEmail: 'legacy-a@example.com',
          legacyUserId: 7,
          claimStatus: 'CLAIMED',
        },
      ],
      auditByTarget: {
        [NEW_SUB_A]: [
          { action: 'USER_CLAIM', claimId: 'claim-a' },
          { action: 'USER_CLAIM_FANOUT', claimId: 'claim-a', after: { table: 'Sdr' } },
          { action: 'USER_CLAIM_FANOUT', claimId: 'claim-a', after: { table: 'Comment' } },
          // Missing: AbuseReport, Donation, Recording, etc.
        ],
      },
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.fanOutSpy).toHaveBeenCalledOnce();
    const args = deps.fanOutSpy.mock.calls[0]?.[0] as {
      oldSub: string;
      newSub: string;
      claimId: string;
      deps: { getCompletedTables: (claimId: string) => Promise<ReadonlySet<string>> };
    };
    expect(args.newSub).toBe(NEW_SUB_A);
    expect(args.claimId).toBe('claim-a');
    const completed = await args.deps.getCompletedTables('claim-a');
    expect(completed.has('Sdr')).toBe(true);
    expect(completed.has('Comment')).toBe(true);
    expect(completed.has('AbuseReport')).toBe(false);
  });

  it('derives oldSub from the legacy user attribution chain', async () => {
    // The User row PK has been rewritten to the real Cognito sub, but
    // `legacyUserId` + `legacyEmail` survived the rewrite. Sweeper uses
    // `legacy:<legacyUserId>` as the `oldSub` (matches the migration
    // seeding convention from #259).
    const deps = makeDeps({
      claimedUsers: [
        {
          cognitoSub: NEW_SUB_A,
          email: 'a@example.com',
          legacyEmail: 'legacy-a@example.com',
          legacyUserId: 42,
          claimStatus: 'CLAIMED',
        },
      ],
      auditByTarget: {
        [NEW_SUB_A]: [{ action: 'USER_CLAIM', claimId: 'claim-a' }],
      },
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    const args = deps.fanOutSpy.mock.calls[0]?.[0] as { oldSub: string };
    expect(args.oldSub).toBe('legacy:42');
  });

  it('iterates over every CLAIMED user (multiple users in one sweep)', async () => {
    const deps = makeDeps({
      claimedUsers: [
        {
          cognitoSub: NEW_SUB_A,
          email: 'a@example.com',
          legacyEmail: 'a@example.com',
          legacyUserId: 1,
          claimStatus: 'CLAIMED',
        },
        {
          cognitoSub: NEW_SUB_B,
          email: 'b@example.com',
          legacyEmail: 'b@example.com',
          legacyUserId: 2,
          claimStatus: 'CLAIMED',
        },
      ],
      auditByTarget: {
        [NEW_SUB_A]: [{ action: 'USER_CLAIM', claimId: 'claim-a' }],
        [NEW_SUB_B]: [{ action: 'USER_CLAIM', claimId: 'claim-b' }],
      },
    });
    __setDeps(deps);

    await handler(event, context, () => undefined);

    expect(deps.fanOutSpy).toHaveBeenCalledTimes(2);
    const subs = deps.fanOutSpy.mock.calls.map((c) => (c[0] as { newSub: string }).newSub);
    expect(subs).toEqual(expect.arrayContaining([NEW_SUB_A, NEW_SUB_B]));
  });

  it('skips a CLAIMED user whose audit log has no USER_CLAIM entry (cannot derive claimId)', async () => {
    // Defensive: a CLAIMED row with no USER_CLAIM audit means the row
    // pre-dates the claimId-threading work or was manually altered.
    // Skip + log so a human can investigate, but never blow up the
    // sweep on one bad row.
    const deps = makeDeps({
      claimedUsers: [
        {
          cognitoSub: NEW_SUB_A,
          email: 'a@example.com',
          legacyEmail: 'a@example.com',
          legacyUserId: 1,
          claimStatus: 'CLAIMED',
        },
      ],
      auditByTarget: {
        [NEW_SUB_A]: [],
      },
    });
    __setDeps(deps);
    const errorSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handler(event, context, () => undefined);

    expect(deps.fanOutSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('continues to the next user when one user fan-out throws', async () => {
    const deps = makeDeps({
      claimedUsers: [
        {
          cognitoSub: NEW_SUB_A,
          email: 'a@example.com',
          legacyEmail: 'a@example.com',
          legacyUserId: 1,
          claimStatus: 'CLAIMED',
        },
        {
          cognitoSub: NEW_SUB_B,
          email: 'b@example.com',
          legacyEmail: 'b@example.com',
          legacyUserId: 2,
          claimStatus: 'CLAIMED',
        },
      ],
      auditByTarget: {
        [NEW_SUB_A]: [{ action: 'USER_CLAIM', claimId: 'claim-a' }],
        [NEW_SUB_B]: [{ action: 'USER_CLAIM', claimId: 'claim-b' }],
      },
    });
    // First call throws, second succeeds.
    deps.fanOutSpy
      .mockImplementationOnce(() => Promise.reject(new Error('DDB throttled')))
      .mockImplementationOnce(() =>
        Promise.resolve({
          Sdr: 0,
          Comment: 0,
          AbuseReport: 0,
          Donation: 0,
          Recording: 0,
          TranscriptRevision: 0,
          User: 0,
          Message: 0,
          FieldVote: 0,
          RevisionVote: 0,
          Reputation: 0,
          NotificationPreference: 0,
        }),
      );
    __setDeps(deps);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handler(event, context, () => undefined);

    expect(deps.fanOutSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
