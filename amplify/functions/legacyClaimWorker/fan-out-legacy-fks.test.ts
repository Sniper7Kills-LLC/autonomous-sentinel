import { describe, it, expect, vi } from 'vitest';
import {
  fanOutLegacyFks,
  type FanOutDeps,
  type FanOutTableNames,
  type DdbItem,
  type TransactWriteOp,
} from './fan-out-legacy-fks';

/**
 * Tests for `fanOutLegacyFks` — the per-table FK rewrite half of the
 * legacy-claim flow (sub-B of #16, tracked at #273).
 *
 * Three operation shapes covered:
 *
 *   1. Simple FK column rewrite (Update on row PK) — `Sdr.ownerId`,
 *      `Comment.authorId`, `AbuseReport.reporterId`, `Donation.userId`,
 *      `Recording.uploaderId`, `TranscriptRevision.proposedBy`,
 *      `User.bannedById`.
 *   2. PK-part FK (per-row Delete+Put because the PK changes) —
 *      `FieldVote.voterId` (part of synthesised `fieldKey`),
 *      `RevisionVote.voterId` (part of compound identifier).
 *   3. PK == userId (single Delete+Put on the PK row) — `Reputation`,
 *      `NotificationPreference`.
 *
 * Each table emits a `USER_CLAIM_FANOUT` AuditLog entry per batch the
 * `transact` call writes; PR C (#274) will read this manifest to know
 * which tables have already fanned out on partial-state replay.
 */

const OLD_SUB = 'legacy:42';
const NEW_SUB = 'cog-real-sub-001';
const CLAIM_ID = 'claim-id-fixed-273';

const TABLES: FanOutTableNames = {
  Sdr: 'Sdr-table',
  Comment: 'Comment-table',
  AbuseReport: 'AbuseReport-table',
  Donation: 'Donation-table',
  Recording: 'Recording-table',
  TranscriptRevision: 'TranscriptRevision-table',
  User: 'User-table',
  FieldVote: 'FieldVote-table',
  RevisionVote: 'RevisionVote-table',
  Reputation: 'Reputation-table',
  NotificationPreference: 'NotificationPreference-table',
};

interface RowsByTable {
  [tableName: string]: DdbItem[];
}

function makeDeps(
  rows: RowsByTable = {},
  overrides: Partial<FanOutDeps> = {},
): FanOutDeps & {
  querySpy: ReturnType<typeof vi.fn>;
  transactSpy: ReturnType<typeof vi.fn>;
  auditSpy: ReturnType<typeof vi.fn>;
} {
  const querySpy = vi.fn(({ tableName }: { tableName: string }) =>
    Promise.resolve({ items: rows[tableName] ?? [] }),
  );
  const transactSpy = vi.fn(() => Promise.resolve());
  const auditSpy = vi.fn(() => Promise.resolve('audit-id-fanout'));
  return {
    querySpy,
    transactSpy,
    auditSpy,
    tableNames: TABLES,
    query: querySpy,
    transact: transactSpy,
    audit: auditSpy,
    batchSize: 25,
    ...overrides,
  };
}

describe('fanOutLegacyFks — simple FK column rewrite', () => {
  it('rewrites Sdr.ownerId from oldSub to newSub via transact Update', async () => {
    const deps = makeDeps({
      'Sdr-table': [
        { id: 'sdr-1', ownerId: OLD_SUB, name: 'Radio One' },
        { id: 'sdr-2', ownerId: OLD_SUB, name: 'Radio Two' },
      ],
    });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    // Query by ownerId GSI
    expect(deps.querySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: 'Sdr-table',
        indexName: 'sdr-ownerId-index',
        fkColumn: 'ownerId',
        fkValue: OLD_SUB,
      }),
    );

    // Transact contains Update ops with new ownerId value
    const calls = deps.transactSpy.mock.calls;
    const allOps = calls.flatMap((c) => c[0] as TransactWriteOp[]);
    const sdrUpdates = allOps.filter((op) => op.kind === 'Update' && op.tableName === 'Sdr-table');
    expect(sdrUpdates).toHaveLength(2);
    expect(sdrUpdates[0]?.kind === 'Update' && sdrUpdates[0].set.ownerId).toBe(NEW_SUB);
  });

  it('rewrites Comment.authorId, AbuseReport.reporterId, Donation.userId, Recording.uploaderId, TranscriptRevision.proposedBy, User.bannedById', async () => {
    const deps = makeDeps({
      'Comment-table': [{ id: 'c-1', authorId: OLD_SUB, body: 'hi' }],
      'AbuseReport-table': [{ id: 'a-1', reporterId: OLD_SUB }],
      'Donation-table': [{ id: 'd-1', userId: OLD_SUB }],
      'Recording-table': [{ id: 'r-1', uploaderId: OLD_SUB }],
      'TranscriptRevision-table': [{ id: 't-1', proposedBy: OLD_SUB }],
      'User-table': [{ cognitoSub: 'cog-admin', bannedById: OLD_SUB }],
    });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    const allOps = deps.transactSpy.mock.calls.flatMap((c) => c[0] as TransactWriteOp[]);

    const checks: { table: string; column: string }[] = [
      { table: 'Comment-table', column: 'authorId' },
      { table: 'AbuseReport-table', column: 'reporterId' },
      { table: 'Donation-table', column: 'userId' },
      { table: 'Recording-table', column: 'uploaderId' },
      { table: 'TranscriptRevision-table', column: 'proposedBy' },
      { table: 'User-table', column: 'bannedById' },
    ];
    for (const { table, column } of checks) {
      const ops = allOps.filter((op) => op.tableName === table && op.kind === 'Update');
      expect(ops.length, `expected an Update on ${table}.${column}`).toBeGreaterThan(0);
      const setValue =
        ops[0]?.kind === 'Update' ? (ops[0].set[column] as string | undefined) : undefined;
      expect(setValue).toBe(NEW_SUB);
    }
  });

  it('skips a table whose Query returns no rows (no transact, no audit for that table)', async () => {
    const deps = makeDeps({}); // every table empty
    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });
    expect(deps.transactSpy).not.toHaveBeenCalled();
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });

  it('chunks updates into batches of `batchSize` (default 25)', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `sdr-${i}`,
      ownerId: OLD_SUB,
    }));
    const deps = makeDeps({ 'Sdr-table': rows });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    // 60 rows / 25 batchSize = 3 transact calls (25 + 25 + 10)
    const sdrCalls = deps.transactSpy.mock.calls.filter((c) =>
      (c[0] as TransactWriteOp[]).some((op) => op.tableName === 'Sdr-table'),
    );
    expect(sdrCalls).toHaveLength(3);
    expect((sdrCalls[0]?.[0] as TransactWriteOp[]).length).toBe(25);
    expect((sdrCalls[1]?.[0] as TransactWriteOp[]).length).toBe(25);
    expect((sdrCalls[2]?.[0] as TransactWriteOp[]).length).toBe(10);
  });
});

describe('fanOutLegacyFks — PK-part FK (FieldVote, RevisionVote)', () => {
  it('FieldVote: deletes old row + puts new row with rewritten fieldKey + voterId', async () => {
    const deps = makeDeps({
      'FieldVote-table': [
        {
          fieldKey: `msg-1#SENDER#${OLD_SUB}`,
          messageId: 'msg-1',
          field: 'SENDER',
          voterId: OLD_SUB,
          value: 'SKYKING',
          weightAtVoteTime: 1,
        },
      ],
    });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    const allOps = deps.transactSpy.mock.calls.flatMap((c) => c[0] as TransactWriteOp[]);
    const fvOps = allOps.filter((op) => op.tableName === 'FieldVote-table');

    const del = fvOps.find((op) => op.kind === 'Delete');
    const put = fvOps.find((op) => op.kind === 'Put');
    expect(del?.kind === 'Delete' && del.key.fieldKey).toBe(`msg-1#SENDER#${OLD_SUB}`);
    expect(put?.kind === 'Put' && put.row.fieldKey).toBe(`msg-1#SENDER#${NEW_SUB}`);
    expect(put?.kind === 'Put' && put.row.voterId).toBe(NEW_SUB);
    // Other columns preserved
    expect(put?.kind === 'Put' && put.row.value).toBe('SKYKING');
    expect(put?.kind === 'Put' && put.row.weightAtVoteTime).toBe(1);
  });

  it('RevisionVote: deletes old (revisionId, oldSub) + puts new (revisionId, newSub)', async () => {
    const deps = makeDeps({
      'RevisionVote-table': [
        {
          revisionId: 'rev-1',
          voterId: OLD_SUB,
          value: 'UP',
          weightAtVoteTime: 1,
        },
      ],
    });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    const allOps = deps.transactSpy.mock.calls.flatMap((c) => c[0] as TransactWriteOp[]);
    const ops = allOps.filter((op) => op.tableName === 'RevisionVote-table');
    const del = ops.find((op) => op.kind === 'Delete');
    const put = ops.find((op) => op.kind === 'Put');
    expect(del?.kind === 'Delete' && del.key.revisionId).toBe('rev-1');
    expect(del?.kind === 'Delete' && del.key.voterId).toBe(OLD_SUB);
    expect(put?.kind === 'Put' && put.row.voterId).toBe(NEW_SUB);
  });

  it('PK-part rewrites are chunked so Delete+Put pair stays in the same transact call', async () => {
    // FieldVote: each row produces 2 ops (Delete + Put). batchSize 25
    // means max 12 rows per transact (24 ops) — the 13th row's pair
    // rolls into the next call. 14 rows → 2 calls (24 + 4 ops).
    const rows = Array.from({ length: 14 }, (_, i) => ({
      fieldKey: `msg-${i}#SENDER#${OLD_SUB}`,
      messageId: `msg-${i}`,
      field: 'SENDER',
      voterId: OLD_SUB,
      value: 'X',
      weightAtVoteTime: 1,
    }));
    const deps = makeDeps({ 'FieldVote-table': rows });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    const fvCalls = deps.transactSpy.mock.calls.filter((c) =>
      (c[0] as TransactWriteOp[]).some((op) => op.tableName === 'FieldVote-table'),
    );
    expect(fvCalls).toHaveLength(2);
    // First call has 24 ops (12 pairs); second has 4 ops (2 pairs).
    expect((fvCalls[0]?.[0] as TransactWriteOp[]).length).toBe(24);
    expect((fvCalls[1]?.[0] as TransactWriteOp[]).length).toBe(4);
  });
});

describe('fanOutLegacyFks — PK == userId (Reputation, NotificationPreference)', () => {
  it('rewrites Reputation row via Delete oldUserId + Put newUserId', async () => {
    const deps = makeDeps({
      'Reputation-table': [{ userId: OLD_SUB, computedWeight: 2.5, validatedSubmissions: 3 }],
    });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    const allOps = deps.transactSpy.mock.calls.flatMap((c) => c[0] as TransactWriteOp[]);
    const repOps = allOps.filter((op) => op.tableName === 'Reputation-table');
    const del = repOps.find((op) => op.kind === 'Delete');
    const put = repOps.find((op) => op.kind === 'Put');
    expect(del?.kind === 'Delete' && del.key.userId).toBe(OLD_SUB);
    expect(put?.kind === 'Put' && put.row.userId).toBe(NEW_SUB);
    expect(put?.kind === 'Put' && put.row.computedWeight).toBe(2.5);
  });

  it('rewrites NotificationPreference row via Delete oldUserId + Put newUserId', async () => {
    const deps = makeDeps({
      'NotificationPreference-table': [{ userId: OLD_SUB, subscribedTypes: ['SKYKING'] }],
    });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    const allOps = deps.transactSpy.mock.calls.flatMap((c) => c[0] as TransactWriteOp[]);
    const npOps = allOps.filter((op) => op.tableName === 'NotificationPreference-table');
    expect(npOps.length).toBe(2);
  });

  it('no-op when the userId-keyed row does not exist', async () => {
    const deps = makeDeps({}); // no Reputation, no NotificationPreference rows
    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });
    const reputationOps = deps.transactSpy.mock.calls.flatMap((c) =>
      (c[0] as TransactWriteOp[]).filter((op) => op.tableName === 'Reputation-table'),
    );
    expect(reputationOps).toHaveLength(0);
  });
});

describe('fanOutLegacyFks — manifest-skip (PR C / #274)', () => {
  it('skips tables present in deps.getCompletedTables(claimId)', async () => {
    const deps = makeDeps(
      {
        'Sdr-table': [{ id: 'sdr-1', ownerId: OLD_SUB }],
        'Comment-table': [{ id: 'c-1', authorId: OLD_SUB }],
      },
      {
        getCompletedTables: vi.fn(() => Promise.resolve(new Set(['Sdr'] as const))),
      },
    );

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    // Sdr is in the completed set → no Query, no transact, no audit.
    expect(
      deps.querySpy.mock.calls.find(
        (c) => (c[0] as { tableName: string }).tableName === 'Sdr-table',
      ),
    ).toBeUndefined();
    // Comment is not in the completed set → fan-out runs as normal.
    const allOps = deps.transactSpy.mock.calls.flatMap((c) => c[0] as TransactWriteOp[]);
    const commentOps = allOps.filter((op) => op.tableName === 'Comment-table');
    expect(commentOps.length).toBeGreaterThan(0);
  });

  it('summary reports 0 for skipped tables, real count for run tables', async () => {
    const deps = makeDeps(
      {
        'Sdr-table': [
          { id: 'sdr-1', ownerId: OLD_SUB },
          { id: 'sdr-2', ownerId: OLD_SUB },
        ],
        'Comment-table': [{ id: 'c-1', authorId: OLD_SUB }],
      },
      {
        getCompletedTables: vi.fn(() => Promise.resolve(new Set(['Sdr'] as const))),
      },
    );

    const summary = await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    expect(summary.Sdr).toBe(0); // skipped
    expect(summary.Comment).toBe(1); // ran
  });

  it('passes claimId to getCompletedTables (manifest lookup is per-claim)', async () => {
    const getCompletedTables = vi.fn(() => Promise.resolve(new Set<never>()));
    const deps = makeDeps({}, { getCompletedTables });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    expect(getCompletedTables).toHaveBeenCalledWith(CLAIM_ID);
  });

  it('is a no-op when getCompletedTables returns every table', async () => {
    const deps = makeDeps(
      {
        'Sdr-table': [{ id: 'sdr-1', ownerId: OLD_SUB }],
      },
      {
        getCompletedTables: vi.fn(() =>
          Promise.resolve(
            new Set([
              'Sdr',
              'Comment',
              'AbuseReport',
              'Donation',
              'Recording',
              'TranscriptRevision',
              'User',
              'FieldVote',
              'RevisionVote',
              'Reputation',
              'NotificationPreference',
            ] as const),
          ),
        ),
      },
    );

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    expect(deps.querySpy).not.toHaveBeenCalled();
    expect(deps.transactSpy).not.toHaveBeenCalled();
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });
});

describe('fanOutLegacyFks — audit manifest', () => {
  it('emits one USER_CLAIM_FANOUT audit per (table, batch)', async () => {
    const sdrRows = Array.from({ length: 30 }, (_, i) => ({
      id: `sdr-${i}`,
      ownerId: OLD_SUB,
    }));
    const deps = makeDeps({
      'Sdr-table': sdrRows,
      'Comment-table': [{ id: 'c-1', authorId: OLD_SUB }],
    });

    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    // 30 Sdr rows → 2 batches (25 + 5). 1 Comment row → 1 batch. Total 3.
    expect(deps.auditSpy).toHaveBeenCalledTimes(3);
    const auditOpts = deps.auditSpy.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(auditOpts.every((o) => o.action === 'USER_CLAIM_FANOUT')).toBe(true);
    expect(auditOpts.every((o) => o.claimId === CLAIM_ID)).toBe(true);
    expect(auditOpts.every((o) => o.targetType === 'User')).toBe(true);
    expect(auditOpts.every((o) => o.targetId === NEW_SUB)).toBe(true);
  });

  it('audit entry records the table + row count for the batch', async () => {
    const deps = makeDeps({
      'Sdr-table': [{ id: 'sdr-1', ownerId: OLD_SUB }],
    });
    await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });
    const [, opts] = deps.auditSpy.mock.calls[0] as [unknown, Record<string, unknown>];
    const after = opts.after as Record<string, unknown>;
    expect(after.table).toBe('Sdr');
    expect(after.rowCount).toBe(1);
    expect(after.oldSub).toBe(OLD_SUB);
    expect(after.newSub).toBe(NEW_SUB);
  });

  it('returns a per-table summary the caller can log', async () => {
    const deps = makeDeps({
      'Sdr-table': [
        { id: 'sdr-1', ownerId: OLD_SUB },
        { id: 'sdr-2', ownerId: OLD_SUB },
      ],
      'Comment-table': [{ id: 'c-1', authorId: OLD_SUB }],
    });
    const summary = await fanOutLegacyFks({
      oldSub: OLD_SUB,
      newSub: NEW_SUB,
      claimId: CLAIM_ID,
      deps,
    });

    expect(summary.Sdr).toBe(2);
    expect(summary.Comment).toBe(1);
    expect(summary.Donation).toBe(0);
  });

  it('propagates transact failure without writing the per-batch audit', async () => {
    const deps = makeDeps(
      { 'Sdr-table': [{ id: 'sdr-1', ownerId: OLD_SUB }] },
      {
        transact: vi.fn(() => Promise.reject(new Error('TransactionCanceledException'))),
      },
    );

    await expect(
      fanOutLegacyFks({
        oldSub: OLD_SUB,
        newSub: NEW_SUB,
        claimId: CLAIM_ID,
        deps,
      }),
    ).rejects.toThrow(/TransactionCanceledException/);
    expect(deps.auditSpy).not.toHaveBeenCalled();
  });
});
