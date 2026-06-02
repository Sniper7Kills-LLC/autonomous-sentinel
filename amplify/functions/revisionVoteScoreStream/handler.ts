import type { DynamoDBStreamHandler } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, type QueryCommandOutput } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

/**
 * RevisionVote DynamoDB-stream consumer (#653).
 *
 * `castRevisionVote` snapshots each voter's `weightAtVoteTime` but nothing
 * recomputed the parent `TranscriptRevision.voteScore`, so casting a vote
 * never moved the displayed score. On every INSERT / MODIFY / REMOVE this
 * handler re-derives the affected revision's score from its live votes
 * (UP = +weight, DOWN = -weight) and writes it back.
 *
 * Reads use a DDB Query keyed on the RevisionVote partition key
 * (`revisionId`) — NOT a table Scan — so cost scales with one revision's
 * vote count, not the whole table. The `voteScore` write goes through the
 * Amplify Data IAM client so it stamps `updatedAt` + fires the AppSync
 * subscription (a raw SDK PutItem would leave the Amplify-managed
 * timestamps null, the same class of bug as #649).
 */

const REVISION_VOTE_TABLE_ENV = 'REVISION_VOTE_TABLE_NAME';

export interface VoteWeight {
  value: string;
  weight: number;
}

/**
 * voteScore = Σ (UP → +weight, DOWN → -weight). Unknown values contribute
 * 0 so a future enum value can't silently swing the score.
 */
export function computeVoteScore(votes: VoteWeight[]): number {
  let score = 0;
  for (const v of votes) {
    const w = Number.isFinite(v.weight) ? v.weight : 0;
    if (v.value === 'UP') score += w;
    else if (v.value === 'DOWN') score -= w;
  }
  // Avoid float drift (0.1 + 0.2 …) leaking into the stored score.
  return Math.round(score * 1000) / 1000;
}

/**
 * Pull the distinct `revisionId`s touched by a stream batch. The PK is
 * carried on `Keys` for every event type (INSERT / MODIFY / REMOVE), so a
 * deleted vote still triggers a recompute of its (former) revision.
 */
export function extractRevisionIds(
  records: { dynamodb?: { Keys?: Record<string, { S?: string }> } }[],
): string[] {
  const ids = new Set<string>();
  for (const r of records) {
    const id = r.dynamodb?.Keys?.revisionId?.S;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return Array.from(ids);
}

// --- dependency injection seam (mirrors the other stream handlers) ------

export interface RevisionScoreDataClient {
  models: {
    TranscriptRevision: {
      update: (input: {
        id: string;
        voteScore: number;
      }) => Promise<{ data: unknown; errors?: unknown }>;
    };
  };
}

interface Deps {
  /** Returns every vote (value + weight) for one revision. */
  listVotes?: (revisionId: string) => Promise<VoteWeight[]>;
  dataClient?: RevisionScoreDataClient;
}

let injected: Deps = {};

export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

function tableName(): string {
  const v = process.env[REVISION_VOTE_TABLE_ENV];
  if (!v)
    throw new Error(`revisionVoteScoreStream: ${REVISION_VOTE_TABLE_ENV} env var is required`);
  return v;
}

let cachedDdb: DynamoDBClient | undefined;
function ddbClient(): DynamoDBClient {
  if (!cachedDdb) cachedDdb = new DynamoDBClient({});
  return cachedDdb;
}

/** Query all RevisionVote rows for a revision by the `revisionId` PK. */
async function defaultListVotes(revisionId: string): Promise<VoteWeight[]> {
  const client = ddbClient();
  const out: VoteWeight[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await client.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'revisionId = :rid',
        ExpressionAttributeValues: marshall({ ':rid': revisionId }),
        ExclusiveStartKey: exclusiveStartKey as never,
      }),
    );
    for (const item of res.Items ?? []) {
      const row = unmarshall(item) as { value?: unknown; weightAtVoteTime?: unknown };
      out.push({
        value: typeof row.value === 'string' ? row.value : '',
        weight: typeof row.weightAtVoteTime === 'number' ? row.weightAtVoteTime : 1,
      });
    }
    exclusiveStartKey = res.LastEvaluatedKey
      ? (unmarshall(res.LastEvaluatedKey) as Record<string, unknown>)
      : undefined;
  } while (exclusiveStartKey);
  return out;
}

let cachedDataClient: RevisionScoreDataClient | undefined;
async function getDefaultDataClient(): Promise<RevisionScoreDataClient> {
  if (cachedDataClient) return cachedDataClient;
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedDataClient = mod.generateClient({ authMode: 'iam' }) as unknown as RevisionScoreDataClient;
  return cachedDataClient;
}

export const handler: DynamoDBStreamHandler = async (event) => {
  const listVotes = injected.listVotes ?? defaultListVotes;
  const revisionIds = extractRevisionIds(event.Records);
  if (revisionIds.length === 0) return;

  const client = injected.dataClient ?? (await getDefaultDataClient());

  for (const revisionId of revisionIds) {
    try {
      const votes = await listVotes(revisionId);
      const voteScore = computeVoteScore(votes);
      const updated = await client.models.TranscriptRevision.update({ id: revisionId, voteScore });
      if (updated.errors) {
        // The parent revision may have been hard-deleted; log + continue so
        // one bad revision doesn't fail the whole batch.
        console.error('revisionVoteScoreStream: TranscriptRevision.update errors', {
          revisionId,
          errors: updated.errors,
        });
      }
    } catch (err) {
      console.error('revisionVoteScoreStream: recompute failed for revision', { revisionId, err });
    }
  }
};
