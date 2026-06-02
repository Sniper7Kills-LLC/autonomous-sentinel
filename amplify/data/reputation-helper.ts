/**
 * Reputation recompute helper (#480).
 *
 * The ONE place that recomputes `Reputation.computedWeight`. Called inline
 * from the Lambdas that already hold AppSync data access:
 *   - `transcriptRevisionMutations` (acceptTranscriptRevision) — the
 *     proposer just earned an accepted correction.
 *   - `linguistic` — a Recording just flipped to PUBLISHED (a validated
 *     submission for its uploader).
 *
 * Inline (not a DDB-stream consumer) on purpose: a stream consumer on the
 * RevisionVote / Recording / TranscriptRevision tables closes a
 * CloudFormation circular dependency, because those tables carry mutation
 * resolvers (see the reverted #658 / #661). Recomputing inside an existing
 * resolver/pipeline Lambda adds no new stack edges.
 *
 * Recompute-from-source (count the user's PUBLISHED recordings + accepted
 * revisions and write the absolute weight) so repeated calls are
 * idempotent and converge — no increment drift.
 */

export interface RepInputs {
  validatedSubmissions: number;
  acceptedCorrections: number;
  /** 0 (member) / 1 (moderator) / 2 (admin). */
  roleBonus: number;
}

export interface RepConstants {
  base: number;
  perValidatedSubmission: number;
  validatedCountCap: number;
  perAcceptedCorrection: number;
  correctionCountCap: number;
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
 * perCorrection·min(ac, cap) + roleBonus). Counts clamp at 0; rounded to
 * 3 dp to keep float drift out of the stored value.
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

/**
 * Minimal Amplify Data client surface the recompute needs. Both calling
 * Lambdas' `generateClient<Schema>()` satisfy this structurally; cast at
 * the call site with `as unknown as ReputationHelperClient`.
 */
export interface ReputationHelperClient {
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

async function countPublishedRecordings(
  client: ReputationHelperClient,
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
  client: ReputationHelperClient,
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

/**
 * Recompute + persist one user's reputation from the live source rows.
 * Returns the new weight. Throws on a hard read error; the caller wraps
 * this best-effort so a recompute failure never fails the parent mutation.
 */
export async function recomputeReputation(
  client: ReputationHelperClient,
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
    throw new Error(`Reputation.update: ${JSON.stringify(updated.errors)}`);
  }
  return computedWeight;
}
