'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';
import { toMapPoints, type MapPoint, type RawSdrPublic, type RawTransmitter } from './points';

/**
 * Data access for the propagation map (#83).
 *
 * Two public reads, both guest-readable so the map works signed-out:
 *   - `client.models.Transmitter.list` — admin-managed broadcast sites
 *     (`allow.guest().to(['read'])`).
 *   - `client.queries.listSdrPublic` — Lambda-backed (#286); filters
 *     soft-deleted + non-public SDRs and blurs lat/lon to the owner's
 *     `locationGranularity`.
 *
 * Auth-mode resolution mirrors `lib/messages/query.ts` /
 * `lib/users/profile.ts`: guests use `identityPool`, signed-in callers
 * use `userPool`. The Amplify Gen 2 `Schema` type does not resolve under
 * eslint's monorepo-root run, so each accessor is funneled through
 * `unknown` and re-typed to the structural shape we consume.
 */

type RawListResult<T> = {
  data?: T[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

// Transmitters are admin-curated; the seeded list is small. We page
// defensively anyway so a future large list still fully renders.
const PAGE_SIZE = 1000;

async function listAllTransmitters(
  authMode: 'identityPool' | 'userPool',
): Promise<RawTransmitter[]> {
  const client = getDataClient();
  const listFn = client.models.Transmitter.list as unknown as (
    input: Record<string, unknown>,
  ) => Promise<RawListResult<RawTransmitter>>;
  const acc: RawTransmitter[] = [];
  let nextToken: string | null | undefined = undefined;
  do {
    const res: RawListResult<RawTransmitter> = await listFn({
      limit: PAGE_SIZE,
      authMode,
      ...(nextToken ? { nextToken } : {}),
    });
    if (res.errors?.length) {
      throw new Error(res.errors.map((e) => e.message).join('; '));
    }
    acc.push(...(res.data ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return acc;
}

async function listPublicSdrs(authMode: 'identityPool' | 'userPool'): Promise<RawSdrPublic[]> {
  const client = getDataClient();
  const queryFn = client.queries.listSdrPublic as unknown as (
    input: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) => Promise<RawListResult<RawSdrPublic>>;
  const res = await queryFn({}, { authMode });
  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join('; '));
  }
  return res.data ?? [];
}

export interface MapData {
  points: MapPoint[];
  /** Counts before/after the null-coord drop are folded into points; these
   *  are the rendered totals per layer (used for the legend + empty states). */
  transmitterCount: number;
  sdrCount: number;
}

/** Fetch transmitters + public SDRs and project them to plottable points. */
export async function loadMapData(): Promise<MapData> {
  const authMode = await resolveAuthMode();
  const [transmitters, sdrs] = await Promise.all([
    listAllTransmitters(authMode),
    listPublicSdrs(authMode),
  ]);
  const points = toMapPoints(transmitters, sdrs);
  return {
    points,
    transmitterCount: points.filter((p) => p.type === 'transmitter').length,
    sdrCount: points.filter((p) => p.type === 'sdr').length,
  };
}
