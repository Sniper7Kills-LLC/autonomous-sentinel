import type { Handler, ScheduledEvent } from 'aws-lambda';
import {
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * `revisionVoteScoreCron` — recompute `TranscriptRevision.voteScore` from the
 * live `RevisionVote` rows on a schedule (#653). See resource.ts for why this
 * is a cron rather than a DDB-stream consumer.
 *
 * 1. Scan RevisionVote in pages, summing `weightAtVoteTime` per `revisionId`
 *    (UP positive, DOWN negative; unknown values contribute 0).
 * 2. For each revision with votes, `UpdateItem TranscriptRevision` SET
 *    voteScore + updatedAt (keyed on `id`; the key is never in the SET, and
 *    the row already exists so its createdAt/updatedAt are intact).
 *
 * Idempotent + convergent: each run derives the absolute score from source,
 * so re-runs and the per-cast snapshot never drift.
 */

const REVISION_VOTE_TABLE_ENV = 'REVISION_VOTE_TABLE_NAME';
const TRANSCRIPT_REVISION_TABLE_ENV = 'TRANSCRIPT_REVISION_TABLE_NAME';

export interface VoteWeight {
  value: string;
  weight: number;
}

/** voteScore = Σ (UP → +weight, DOWN → -weight). Rounded to 3 dp. */
export function sumVoteScore(votes: VoteWeight[]): number {
  let score = 0;
  for (const v of votes) {
    const w = Number.isFinite(v.weight) ? v.weight : 0;
    if (v.value === 'UP') score += w;
    else if (v.value === 'DOWN') score -= w;
  }
  return Math.round(score * 1000) / 1000;
}

/** Fold a page of raw RevisionVote rows into per-revision vote lists. */
export function accumulateVotes(
  rows: Array<{ revisionId?: unknown; value?: unknown; weightAtVoteTime?: unknown }>,
  into: Map<string, VoteWeight[]>,
): void {
  for (const r of rows) {
    if (typeof r.revisionId !== 'string' || r.revisionId.length === 0) continue;
    const list = into.get(r.revisionId) ?? [];
    list.push({
      value: typeof r.value === 'string' ? r.value : '',
      weight: typeof r.weightAtVoteTime === 'number' ? r.weightAtVoteTime : 1,
    });
    into.set(r.revisionId, list);
  }
}

interface Deps {
  /** Returns per-revision vote lists across the whole RevisionVote table. */
  scanAllVotes?: () => Promise<Map<string, VoteWeight[]>>;
  /** Persists one revision's recomputed score. */
  writeScore?: (revisionId: string, voteScore: number, nowIso: string) => Promise<void>;
  now?: () => Date;
}

let injected: Deps = {};
export function __setDeps(deps: Deps): void {
  injected = deps;
}
export function __resetDeps(): void {
  injected = {};
}

function revisionVoteTable(): string {
  const v = process.env[REVISION_VOTE_TABLE_ENV];
  if (!v) throw new Error(`revisionVoteScoreCron: ${REVISION_VOTE_TABLE_ENV} env var is required`);
  return v;
}
function transcriptRevisionTable(): string {
  const v = process.env[TRANSCRIPT_REVISION_TABLE_ENV];
  if (!v)
    throw new Error(`revisionVoteScoreCron: ${TRANSCRIPT_REVISION_TABLE_ENV} env var is required`);
  return v;
}

async function defaultScanAllVotes(): Promise<Map<string, VoteWeight[]>> {
  const client = getDdbClient();
  const table = revisionVoteTable();
  const byRevision = new Map<string, VoteWeight[]>();
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const res: ScanCommandOutput = await client.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: '#r, #v, #w',
        ExpressionAttributeNames: { '#r': 'revisionId', '#v': 'value', '#w': 'weightAtVoteTime' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const rows = (res.Items ?? []).map(
      (it) =>
        unmarshall(it) as { revisionId?: unknown; value?: unknown; weightAtVoteTime?: unknown },
    );
    accumulateVotes(rows, byRevision);
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return byRevision;
}

async function defaultWriteScore(
  revisionId: string,
  voteScore: number,
  nowIso: string,
): Promise<void> {
  const client = getDdbClient();
  await client.send(
    new UpdateItemCommand({
      TableName: transcriptRevisionTable(),
      Key: marshall({ id: revisionId }),
      // `id` (the key) is NOT in SET — DynamoDB rejects updating a key attr
      // (#663). The row already exists (created via AppSync) so createdAt is
      // present; we move voteScore + updatedAt, and pin createdAt with
      // if_not_exists as a defensive net (no-op when present) per the #665
      // non-null-AWSDateTime lesson.
      UpdateExpression:
        'SET #voteScore = :s, #updatedAt = :now, #createdAt = if_not_exists(#createdAt, :now)',
      ExpressionAttributeNames: {
        '#voteScore': 'voteScore',
        '#updatedAt': 'updatedAt',
        '#createdAt': 'createdAt',
      },
      ExpressionAttributeValues: marshall({ ':s': voteScore, ':now': nowIso }),
      // Only update a revision that still exists; a deleted revision is a no-op.
      ConditionExpression: 'attribute_exists(id)',
    }),
  );
}

export interface CronResult {
  revisionsScored: number;
}

// `_context` / `_callback` declared (unused) so the 3-arg Handler call sites
// in tests aren't flagged by CodeQL (js/superfluous-trailing-arguments).
export const handler: Handler<ScheduledEvent, CronResult> = async (_event, _context, _callback) => {
  const scanAllVotes = injected.scanAllVotes ?? defaultScanAllVotes;
  const writeScore = injected.writeScore ?? defaultWriteScore;
  const nowIso = (injected.now ?? (() => new Date()))().toISOString();

  const byRevision = await scanAllVotes();
  let revisionsScored = 0;
  for (const [revisionId, votes] of byRevision) {
    try {
      await writeScore(revisionId, sumVoteScore(votes), nowIso);
      revisionsScored += 1;
    } catch (err) {
      // A deleted revision (ConditionExpression fails) or a transient DDB
      // error on one revision must not abort the whole sweep.
      console.error('revisionVoteScoreCron: writeScore failed for revision', { revisionId, err });
    }
  }
  console.info('revisionVoteScoreCron: swept revision vote scores', { revisionsScored });
  return { revisionsScored };
};
