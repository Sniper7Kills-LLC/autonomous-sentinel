import type { DynamoDBStreamHandler } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

/**
 * reputationRecompute — recompute `Reputation.computedWeight` from source
 * on Recording-publish + TranscriptRevision-accept stream events (#480).
 *
 * See resource.ts for the design rationale (recompute-from-source for
 * idempotency under at-least-once stream delivery).
 */

// --- formula -------------------------------------------------------------

export interface RepInputs {
  validatedSubmissions: number;
  acceptedCorrections: number;
  /** 0 (member) / 1 (moderator) / 2 (admin). */
  roleBonus: number;
}

export interface RepConstants {
  base: number;
  perValidatedSubmission: number;
  /** Max COUNT of validated submissions that contribute (CLAUDE.md: +0.1 each, capped +4 → 40). */
  validatedCountCap: number;
  perAcceptedCorrection: number;
  /** Max COUNT of accepted corrections that contribute (capped +5 → 10). */
  correctionCountCap: number;
  /** Net weight ceiling. */
  netCap: number;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** CLAUDE.md defaults, each env-tunable (every reputation number is admin-tunable). */
export function repConstants(): RepConstants {
  return {
    base: envNum('REP_BASE', 1),
    perValidatedSubmission: envNum('REP_PER_VALIDATED', 0.1),
    validatedCountCap: envNum('REP_VALIDATED_COUNT_CAP', 40),
    perAcceptedCorrection: envNum('REP_PER_CORRECTION', 0.5),
    correctionCountCap: envNum('REP_CORRECTION_COUNT_CAP', 10),
    netCap: envNum('REP_NET_CAP', 5),
  };
}

/**
 * computedWeight = min(netCap, base + perValidated·min(vs, cap) +
 * perCorrection·min(ac, cap) + roleBonus). Counts clamp at 0; result
 * rounded to 3 dp to keep float drift out of the stored value.
 */
export function computeWeight(inputs: RepInputs, c: RepConstants): number {
  const vs = Math.max(0, inputs.validatedSubmissions);
  const ac = Math.max(0, inputs.acceptedCorrections);
  const raw =
    c.base +
    c.perValidatedSubmission * Math.min(vs, c.validatedCountCap) +
    c.perAcceptedCorrection * Math.min(ac, c.correctionCountCap) +
    Math.max(0, inputs.roleBonus);
  return Math.round(Math.min(c.netCap, raw) * 1000) / 1000;
}

export function roleBonusFor(role: string | null | undefined): number {
  if (role === 'admin') return 2;
  if (role === 'moderator') return 1;
  return 0;
}

// --- stream record interpretation ---------------------------------------

// Stream images arrive as a marshalled attribute map. The aws-lambda
// `AttributeValue` and the @aws-sdk/client-dynamodb `AttributeValue`
// differ structurally, so accept a loose record and cast for unmarshall.
type Image = Record<string, unknown> | undefined;

function img(image: Image): Record<string, unknown> {
  return image
    ? (unmarshall(image as Record<string, AttributeValue>) as Record<string, unknown>)
    : {};
}

/**
 * Decide which user (if any) a stream record should trigger a recompute
 * for. Returns the userId, or null when the record is not a relevant
 * transition (so busy-table writes are cheap no-ops).
 *
 *   - Recording: `transcriptionStatus` became 'PUBLISHED' → uploaderId.
 *   - TranscriptRevision: `accepted` became true → proposedBy.
 *
 * The two models are distinguished by their fields (Recording carries
 * `transcriptionStatus` + `uploaderId`; TranscriptRevision carries
 * `accepted` + `proposedBy`).
 */
export function userToRecompute(record: {
  dynamodb?: { NewImage?: Image; OldImage?: Image };
}): string | null {
  const nw = img(record.dynamodb?.NewImage);
  const old = img(record.dynamodb?.OldImage);

  // Recording publish transition.
  if ('transcriptionStatus' in nw || 'uploaderId' in nw) {
    const becamePublished =
      nw.transcriptionStatus === 'PUBLISHED' && old.transcriptionStatus !== 'PUBLISHED';
    if (becamePublished && typeof nw.uploaderId === 'string' && nw.uploaderId.length > 0) {
      return nw.uploaderId;
    }
    return null;
  }

  // TranscriptRevision accept transition.
  if ('accepted' in nw || 'proposedBy' in nw) {
    const becameAccepted = nw.accepted === true && old.accepted !== true;
    if (becameAccepted && typeof nw.proposedBy === 'string' && nw.proposedBy.length > 0) {
      return nw.proposedBy;
    }
    return null;
  }

  return null;
}

// --- data client + DI seam ----------------------------------------------

export interface ReputationDataClient {
  models: {
    Recording: {
      listRecordingByUploaderId: (input: {
        uploaderId: string;
        nextToken?: string | null;
        limit?: number;
      }) => Promise<{
        data: Array<{ transcriptionStatus?: string | null }> | null;
        nextToken?: string | null;
        errors?: unknown;
      }>;
    };
    TranscriptRevision: {
      listTranscriptRevisionByProposedBy: (input: {
        proposedBy: string;
        nextToken?: string | null;
        limit?: number;
      }) => Promise<{
        data: Array<{ accepted?: boolean | null }> | null;
        nextToken?: string | null;
        errors?: unknown;
      }>;
    };
    User: {
      get: (input: {
        cognitoSub: string;
      }) => Promise<{ data: { role?: string | null } | null; errors?: unknown }>;
    };
    Reputation: {
      update: (input: {
        userId: string;
        validatedSubmissions: number;
        acceptedCorrections: number;
        roleBonus: number;
        computedWeight: number;
      }) => Promise<{ data: unknown; errors?: unknown }>;
    };
  };
}

interface Deps {
  client?: ReputationDataClient;
}

let injected: Deps = {};
export function __setDeps(deps: Deps): void {
  injected = deps;
}
export function __resetDeps(): void {
  injected = {};
}

let cachedClient: ReputationDataClient | undefined;
async function getDefaultClient(): Promise<ReputationDataClient> {
  if (cachedClient) return cachedClient;
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedClient = mod.generateClient({ authMode: 'iam' }) as unknown as ReputationDataClient;
  return cachedClient;
}

async function countPublishedRecordings(
  client: ReputationDataClient,
  uploaderId: string,
): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await client.models.Recording.listRecordingByUploaderId({
      uploaderId,
      nextToken: nextToken ?? undefined,
      limit: 1000,
    });
    if (res.errors) throw new Error(`listRecordingByUploaderId: ${JSON.stringify(res.errors)}`);
    for (const r of res.data ?? []) if (r.transcriptionStatus === 'PUBLISHED') count += 1;
    nextToken = res.nextToken;
  } while (nextToken);
  return count;
}

async function countAcceptedRevisions(
  client: ReputationDataClient,
  proposedBy: string,
): Promise<number> {
  let count = 0;
  let nextToken: string | null | undefined;
  do {
    const res = await client.models.TranscriptRevision.listTranscriptRevisionByProposedBy({
      proposedBy,
      nextToken: nextToken ?? undefined,
      limit: 1000,
    });
    if (res.errors)
      throw new Error(`listTranscriptRevisionByProposedBy: ${JSON.stringify(res.errors)}`);
    for (const r of res.data ?? []) if (r.accepted === true) count += 1;
    nextToken = res.nextToken;
  } while (nextToken);
  return count;
}

/** Recompute + persist one user's reputation from the live source rows. */
export async function recomputeReputation(
  client: ReputationDataClient,
  userId: string,
): Promise<number> {
  const [validatedSubmissions, acceptedCorrections, userRes] = await Promise.all([
    countPublishedRecordings(client, userId),
    countAcceptedRevisions(client, userId),
    client.models.User.get({ cognitoSub: userId }),
  ]);
  const roleBonus = roleBonusFor(userRes.data?.role);
  const computedWeight = computeWeight(
    { validatedSubmissions, acceptedCorrections, roleBonus },
    repConstants(),
  );
  const updated = await client.models.Reputation.update({
    userId,
    validatedSubmissions,
    acceptedCorrections,
    roleBonus,
    computedWeight,
  });
  if (updated.errors) {
    // The Reputation row is lazy-created at signup; if it is somehow
    // missing, log + continue rather than failing the whole batch.
    console.error('reputationRecompute: Reputation.update errors', {
      userId,
      errors: updated.errors,
    });
  }
  return computedWeight;
}

// `_context` / `_callback` declared (unused) so 3-arg Handler call sites
// in tests aren't flagged by CodeQL (js/superfluous-trailing-arguments).
export const handler: DynamoDBStreamHandler = async (event, _context, _callback) => {
  const userIds = new Set<string>();
  for (const record of event.Records) {
    const userId = userToRecompute(record);
    if (userId) userIds.add(userId);
  }
  if (userIds.size === 0) return;

  const client = injected.client ?? (await getDefaultClient());
  for (const userId of userIds) {
    try {
      await recomputeReputation(client, userId);
    } catch (err) {
      console.error('reputationRecompute: recompute failed', { userId, err });
    }
  }
};
