import type { Handler } from 'aws-lambda';
import { TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'node:crypto';
import { audit as defaultAudit, type AuditContext } from '../../data/audit-log-helper';
import {
  linkLegacyClaim,
  type LegacyClaimDeps,
  type LegacyUserRow,
  type TransactPkRewriteInput,
  type ClaimAuditFn,
} from '../postConfirmation/link-legacy-claim';
import {
  fanOutLegacyFks,
  type FanOutDeps,
  type FanOutTableNames,
  type FanOutQueryInput,
  type FanOutQueryResult,
  type FanOutSummary,
  type FanOutAuditFn,
  type TransactWriteOp,
} from './fan-out-legacy-fks';
import {
  getDdbClient,
  defaultFanOutTableNames,
  defaultFanOutQuery,
  defaultFanOutTransact,
} from './fan-out-production';

/**
 * `legacyClaimWorker` — async-invoked Lambda that performs the
 * legacy-account PK rewrite off the synchronous Cognito sign-up path
 * (sub-A of #16, #272).
 *
 * Cognito's `PostConfirmation` trigger runs synchronously — the user's
 * sign-up does not complete until the trigger Lambda returns. Doing
 * the DDB transact + audit write inline would delay sign-up by the
 * full round-trip latency (typically 100-500 ms cold, but multi-second
 * on DDB throttle / retry). This worker is invoked with
 * `InvocationType: 'Event'` from `postConfirmation` so the trigger
 * returns immediately and the rewrite happens out-of-band.
 *
 * The worker re-queries the legacy row by email rather than trusting
 * a stale row payload in the event — the postConfirmation Lambda
 * does not pass the row content forward, only the email + new sub,
 * so a parallel claim that already rewrote the row is detectable
 * here (lookup returns the already-CLAIMED row).
 *
 * Failures are rethrown so Lambda's async-invoke retry policy + DLQ
 * take over. Unlike the sync-trigger path, the user is not waiting;
 * loud failure routed to DLQ is the right default so PR-C's replay
 * sweep has something to find.
 */

export interface WorkerDataClient {
  models: {
    User: {
      listUserByEmail: (input: { email: string }) => Promise<{
        data: LegacyUserRow[] | null;
        errors?: unknown;
      }>;
    };
  };
}

export interface WorkerDeps {
  tableName: string;
  dataClient: WorkerDataClient;
  transact: (input: TransactPkRewriteInput) => Promise<void>;
  audit: ClaimAuditFn;
  now: () => Date;
  newClaimId: () => string;
  /**
   * Fan-out dependencies (#273). Composed with the worker so the
   * post-claim FK rewrite shares the same `claimId` thread + audit
   * shape as the User-row claim itself.
   */
  fanOut: {
    tableNames: FanOutTableNames;
    query: (input: FanOutQueryInput) => Promise<FanOutQueryResult>;
    transact: (ops: TransactWriteOp[]) => Promise<void>;
    audit: FanOutAuditFn;
  };
}

export interface LegacyClaimWorkerEvent {
  realSub: string;
  email: string;
  auditContext?: AuditContext;
}

let injected: Partial<WorkerDeps> = {};

export function __setDeps(deps: Partial<WorkerDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedDataClient: WorkerDataClient | undefined;

async function getDataClient(): Promise<WorkerDataClient> {
  if (injected.dataClient) return injected.dataClient;
  if (cachedDataClient) return cachedDataClient;
  const mod = await import('aws-amplify/data');
  cachedDataClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as WorkerDataClient;
  return cachedDataClient;
}

function defaultTableName(): string {
  const fromEnv = process.env.USER_TABLE_NAME;
  if (!fromEnv) {
    throw new Error('legacyClaimWorker: USER_TABLE_NAME env var is required');
  }
  return fromEnv;
}

// Per-table name resolver, the GSI Query / TransactWriteItems
// wrappers, and the `DynamoDBClient` cache used to be inlined here.
// They moved to `./fan-out-production.ts` so the replay sweeper
// (#274) can share them without duplicating the SDK plumbing.

/**
 * Production transactor — wraps DynamoDB TransactWriteItems with a
 * Delete on the legacy PK + Put on the new row. Single transaction =
 * atomic across the rewrite. Either both items apply or neither does.
 */
async function defaultTransact(input: TransactPkRewriteInput): Promise<void> {
  const items: TransactWriteItem[] = [
    {
      Delete: {
        TableName: input.tableName,
        Key: marshall(input.oldPk),
      },
    },
    {
      Put: {
        TableName: input.tableName,
        Item: marshall(input.newRow, { removeUndefinedValues: true }),
      },
    },
  ];
  await getDdbClient().send(new TransactWriteItemsCommand({ TransactItems: items }));
}

// `defaultFanOutQuery` + `defaultFanOutTransact` now live in
// `./fan-out-production.ts` so the replay sweeper (#274) reuses them.

async function resolveDeps(): Promise<WorkerDeps> {
  const tableName = injected.tableName ?? defaultTableName();
  return {
    tableName,
    dataClient: injected.dataClient ?? (await getDataClient()),
    transact: injected.transact ?? defaultTransact,
    audit: injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts)),
    now: injected.now ?? (() => new Date()),
    newClaimId: injected.newClaimId ?? (() => randomUUID()),
    fanOut: injected.fanOut ?? {
      tableNames: defaultFanOutTableNames(tableName),
      query: defaultFanOutQuery,
      transact: defaultFanOutTransact,
      audit: (ctx, opts) => defaultAudit(ctx, opts),
    },
  };
}

export const handler: Handler<LegacyClaimWorkerEvent, void> = async (event) => {
  if (!event.realSub) {
    throw new Error('legacyClaimWorker: realSub is required');
  }
  if (!event.email) {
    throw new Error('legacyClaimWorker: email is required');
  }

  const deps = await resolveDeps();

  const lookup = await deps.dataClient.models.User.listUserByEmail({ email: event.email });
  const rows = lookup.data ?? [];
  const legacyRow = rows[0];
  if (!legacyRow) {
    // Race: a parallel claim already rewrote the row, or migration
    // tooling never seeded one for this email. Either way, no-op.
    console.info('legacyClaimWorker: no legacy row found for email; skipping', {
      realSub: event.realSub,
    });
    return;
  }

  const helperDeps: LegacyClaimDeps = {
    tableName: deps.tableName,
    transact: deps.transact,
    audit: deps.audit,
    now: deps.now,
    newClaimId: deps.newClaimId,
  };

  // Generate the claimId at the worker level so both the User-row
  // claim (#272) and the FK fan-out (#273) share the same manifest
  // key. PR C (#274) reads the resulting audit entries by `claimId`
  // to know what's been done on a partial-state replay.
  const claimId = deps.newClaimId();
  const oldSub = legacyRow.cognitoSub;

  await linkLegacyClaim({
    legacyRow,
    realSub: event.realSub,
    deps: helperDeps,
    auditContext: event.auditContext,
    claimId,
  });

  // Fan out the FK rewrite across the 11 child tables (#273). Each
  // table emits its own USER_CLAIM_FANOUT manifest entries. If the
  // User row was already CLAIMED (idempotent retry), this still runs
  // — but each Query returns 0 rows because the FK already equals
  // the new sub, so the fan-out is a no-op.
  const fanOutDeps: FanOutDeps = {
    ...deps.fanOut,
    auditContext: event.auditContext,
  };
  const summary: FanOutSummary = await fanOutLegacyFks({
    oldSub,
    newSub: event.realSub,
    claimId,
    deps: fanOutDeps,
  });
  console.info('legacyClaimWorker: fan-out complete', {
    realSub: event.realSub,
    claimId,
    summary,
  });
};
