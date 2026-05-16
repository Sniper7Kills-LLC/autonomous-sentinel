/**
 * `fanOutLegacyFks` — per-table FK rewrite half of the legacy-claim
 * flow (sub-B of #16, tracked at #273).
 *
 * After `linkLegacyClaim` (sub-A / #272) atomically rewrites the User
 * row PK from `legacy:<id>` to the real Cognito sub, every child
 * table that holds a FK pointing at the old PK still references it.
 * This helper sweeps the 11 User-FK tables and rewrites each FK.
 *
 * Three operation shapes (driven by table identifier semantics):
 *
 *   1. **Simple FK column** — Sdr.ownerId, Comment.authorId,
 *      AbuseReport.reporterId, Donation.userId, Recording.uploaderId,
 *      TranscriptRevision.proposedBy, User.bannedById. Row PK does not
 *      change; emit a single `Update` per row inside a `TransactWriteItems`
 *      batch of `batchSize` ops.
 *
 *   2. **PK-part FK** — FieldVote.voterId (part of synthesised
 *      `fieldKey`), RevisionVote.voterId (part of compound identifier).
 *      Row PK changes, so each rewrite is a paired `Delete` (old PK) +
 *      `Put` (new row with rewritten PK + FK). The pair must stay in
 *      the same transact call (atomic), so the batcher chunks rows so
 *      pairs never span calls.
 *
 *   3. **PK == userId** — Reputation, NotificationPreference. The
 *      identifier *is* the FK, so the rewrite is the same Delete+Put
 *      pair as shape 2 but always exactly one row per table.
 *
 * For every batch the `transact` call writes, the helper emits a
 * `USER_CLAIM_FANOUT` AuditLog entry tagged with the `claimId` so PR
 * C (#274) can read the manifest on partial-state replay.
 *
 * **Audit-after-transact ordering**: the per-batch audit write happens
 * *after* the transact succeeds, not atomically with it. If the
 * transact succeeds and the audit then fails, the FK rewrite is
 * committed but the manifest entry is missing. PR C's replay sweep
 * handles this case safely because Query is the source of truth — a
 * row whose FK already equals `newSub` is treated as fanned-out
 * regardless of whether the manifest has the entry. The audit log
 * may therefore have a hole on rare transact-then-audit-fail
 * sequences; rebuilding the manifest from row state is the recovery
 * path. Do not tighten any downstream reader to require manifest
 * completeness without first switching to a transact-bundled audit.
 *
 * Dependency-injected: tests stub `query` / `transact` / `audit`. The
 * worker wires the production DDB SDK + Amplify Data client.
 */

import type { AuditContext, AuditOptions } from '../../data/audit-log-helper';

export type DdbItem = Record<string, unknown>;

/**
 * Subset of operations the helper emits to `transact`. Production
 * maps these to DDB `TransactWriteItems` (Update / Delete / Put).
 */
export type TransactWriteOp =
  | { kind: 'Update'; tableName: string; key: DdbItem; set: DdbItem }
  | { kind: 'Delete'; tableName: string; key: DdbItem }
  | { kind: 'Put'; tableName: string; row: DdbItem };

export interface FanOutTableNames {
  Sdr: string;
  Comment: string;
  AbuseReport: string;
  Donation: string;
  Recording: string;
  TranscriptRevision: string;
  User: string;
  FieldVote: string;
  RevisionVote: string;
  Reputation: string;
  NotificationPreference: string;
}

export type TableKey = keyof FanOutTableNames;

export interface FanOutQueryInput {
  tableName: string;
  indexName: string;
  fkColumn: string;
  fkValue: string;
}

export interface FanOutQueryResult {
  items: DdbItem[];
}

export interface FanOutAuditOptions extends AuditOptions {
  action: Extract<AuditOptions['action'], 'USER_CLAIM_FANOUT'>;
  claimId: string;
}

export type FanOutAuditFn = (ctx: AuditContext, opts: FanOutAuditOptions) => Promise<string>;

export interface FanOutDeps {
  tableNames: FanOutTableNames;
  query: (input: FanOutQueryInput) => Promise<FanOutQueryResult>;
  transact: (ops: TransactWriteOp[]) => Promise<void>;
  audit: FanOutAuditFn;
  /** Max ops per `TransactWriteItems` call. Default 25 (DDB limit). */
  batchSize?: number;
  /** Optional audit context — defaults to system actor. */
  auditContext?: AuditContext;
}

export interface FanOutArgs {
  oldSub: string;
  newSub: string;
  claimId: string;
  deps: FanOutDeps;
}

export type FanOutSummary = Record<TableKey, number>;

/**
 * Per-table descriptors. Each entry encodes which GSI to scan + which
 * shape of rewrite to emit. The synthesised composite PK on FieldVote
 * is rebuilt inside the row mapper (`buildRow`) so the worker stays
 * out of that detail.
 */
interface SimpleColumnTable {
  shape: 'simple-column';
  table: TableKey;
  indexName: string;
  fkColumn: string;
  /** PK column on this table (single-key tables only). */
  pkColumn: string;
}

interface PkPartTable {
  shape: 'pk-part';
  table: TableKey;
  indexName: string;
  fkColumn: string;
  /** Build the row's PK from the row; used for Delete `key`. */
  keyOf: (row: DdbItem) => DdbItem;
  /** Build the rewritten row from the original row + newSub. */
  buildRow: (row: DdbItem, newSub: string) => DdbItem;
}

interface PkUserIdTable {
  shape: 'pk-userid';
  table: TableKey;
  pkColumn: 'userId';
}

type FanOutTableDescriptor = SimpleColumnTable | PkPartTable | PkUserIdTable;

const TABLE_DESCRIPTORS: readonly FanOutTableDescriptor[] = [
  // Shape 1 — simple FK column rewrite
  {
    shape: 'simple-column',
    table: 'Sdr',
    indexName: 'sdr-ownerId-index',
    fkColumn: 'ownerId',
    pkColumn: 'id',
  },
  {
    shape: 'simple-column',
    table: 'Comment',
    indexName: 'comment-authorId-index',
    fkColumn: 'authorId',
    pkColumn: 'id',
  },
  {
    shape: 'simple-column',
    table: 'AbuseReport',
    indexName: 'abuseReport-reporterId-index',
    fkColumn: 'reporterId',
    pkColumn: 'id',
  },
  {
    shape: 'simple-column',
    table: 'Donation',
    indexName: 'donation-userId-index',
    fkColumn: 'userId',
    pkColumn: 'id',
  },
  {
    shape: 'simple-column',
    table: 'Recording',
    indexName: 'recording-uploaderId-index',
    fkColumn: 'uploaderId',
    pkColumn: 'id',
  },
  {
    shape: 'simple-column',
    table: 'TranscriptRevision',
    indexName: 'transcriptRevision-proposedBy-index',
    fkColumn: 'proposedBy',
    pkColumn: 'id',
  },
  {
    shape: 'simple-column',
    table: 'User',
    indexName: 'user-bannedById-index',
    fkColumn: 'bannedById',
    pkColumn: 'cognitoSub',
  },

  // Shape 2 — PK-part FK
  {
    shape: 'pk-part',
    table: 'FieldVote',
    indexName: 'fieldVote-voterId-index',
    fkColumn: 'voterId',
    keyOf: (row) => ({ fieldKey: row.fieldKey }),
    buildRow: (row, newSub) => {
      const messageId = row.messageId as string;
      const field = row.field as string;
      return {
        ...row,
        voterId: newSub,
        fieldKey: `${messageId}#${field}#${newSub}`,
      };
    },
  },
  {
    shape: 'pk-part',
    table: 'RevisionVote',
    indexName: 'revisionVote-voterId-index',
    fkColumn: 'voterId',
    keyOf: (row) => ({ revisionId: row.revisionId, voterId: row.voterId }),
    buildRow: (row, newSub) => ({ ...row, voterId: newSub }),
  },

  // Shape 3 — PK == userId
  { shape: 'pk-userid', table: 'Reputation', pkColumn: 'userId' },
  { shape: 'pk-userid', table: 'NotificationPreference', pkColumn: 'userId' },
];

function blankSummary(): FanOutSummary {
  return {
    Sdr: 0,
    Comment: 0,
    AbuseReport: 0,
    Donation: 0,
    Recording: 0,
    TranscriptRevision: 0,
    User: 0,
    FieldVote: 0,
    RevisionVote: 0,
    Reputation: 0,
    NotificationPreference: 0,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function fanOutLegacyFks(args: FanOutArgs): Promise<FanOutSummary> {
  const { oldSub, newSub, claimId, deps } = args;
  const batchSize = deps.batchSize ?? 25;
  if (batchSize < 1) {
    throw new Error('fanOutLegacyFks: batchSize must be >= 1');
  }
  const summary = blankSummary();

  for (const desc of TABLE_DESCRIPTORS) {
    const tableName = deps.tableNames[desc.table];
    if (desc.shape === 'pk-userid') {
      // No GSI — the userId IS the PK; we already know the key.
      // Query yields at most one row (existence check). Production
      // adapter wraps a GetItem and surfaces it via the same shape.
      const { items } = await deps.query({
        tableName,
        indexName: '__pk__',
        fkColumn: desc.pkColumn,
        fkValue: oldSub,
      });
      if (items.length === 0) continue;
      const row = items[0]!;
      const newRow: DdbItem = { ...row, userId: newSub };
      const ops: TransactWriteOp[] = [
        { kind: 'Delete', tableName, key: { userId: oldSub } },
        { kind: 'Put', tableName, row: newRow },
      ];
      await deps.transact(ops);
      summary[desc.table] = 1;
      await deps.audit(deps.auditContext ?? { identity: null, request: { headers: {} } }, {
        action: 'USER_CLAIM_FANOUT',
        targetType: 'User',
        targetId: newSub,
        claimId,
        before: { table: desc.table, rowCount: 1 },
        after: { table: desc.table, rowCount: 1, oldSub, newSub },
      });
      continue;
    }

    const { items } = await deps.query({
      tableName,
      indexName: desc.indexName,
      fkColumn: desc.fkColumn,
      fkValue: oldSub,
    });
    if (items.length === 0) continue;
    summary[desc.table] = items.length;

    if (desc.shape === 'simple-column') {
      const ops: TransactWriteOp[] = items.map((row) => ({
        kind: 'Update',
        tableName,
        key: { [desc.pkColumn]: row[desc.pkColumn] },
        set: { [desc.fkColumn]: newSub },
      }));
      for (const batch of chunk(ops, batchSize)) {
        await deps.transact(batch);
        await deps.audit(deps.auditContext ?? { identity: null, request: { headers: {} } }, {
          action: 'USER_CLAIM_FANOUT',
          targetType: 'User',
          targetId: newSub,
          claimId,
          before: { table: desc.table, rowCount: batch.length },
          after: { table: desc.table, rowCount: batch.length, oldSub, newSub },
        });
      }
      continue;
    }

    // shape === 'pk-part' — each row becomes a Delete + Put pair that
    // must stay together in the same transact call to keep the PK
    // rewrite atomic. Chunk so pairs never split: pairsPerBatch =
    // floor(batchSize / 2).
    const pairsPerBatch = Math.max(1, Math.floor(batchSize / 2));
    for (const rowBatch of chunk(items, pairsPerBatch)) {
      const ops: TransactWriteOp[] = [];
      for (const row of rowBatch) {
        ops.push({ kind: 'Delete', tableName, key: desc.keyOf(row) });
        ops.push({ kind: 'Put', tableName, row: desc.buildRow(row, newSub) });
      }
      await deps.transact(ops);
      await deps.audit(deps.auditContext ?? { identity: null, request: { headers: {} } }, {
        action: 'USER_CLAIM_FANOUT',
        targetType: 'User',
        targetId: newSub,
        claimId,
        before: { table: desc.table, rowCount: rowBatch.length },
        after: { table: desc.table, rowCount: rowBatch.length, oldSub, newSub },
      });
    }
  }

  return summary;
}
