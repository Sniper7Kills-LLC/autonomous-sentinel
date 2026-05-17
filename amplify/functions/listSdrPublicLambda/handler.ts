import type { AppSyncResolverHandler } from 'aws-lambda';
import { ScanCommand, type AttributeValue, type ScanCommandOutput } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { getDdbClient } from '../legacyClaimWorker/fan-out-production';

/**
 * `listSdrPublic` Lambda (#286) — PII-aware Sdr listing.
 *
 * Behaviour:
 *   - Reads every Sdr row via paginated Scan.
 *   - Drops soft-deleted rows (`deletedAt` set) for every caller.
 *   - Admin callers (Cognito group `admin`) get the rest unmodified
 *     so the admin propagation-map view can pin exact locations.
 *   - Non-admin + guest callers see only `publicVisible=true` rows
 *     with lat/lon blurred per the owner's `locationGranularity`:
 *       * `EXACT` → no blur (owner opted into full disclosure).
 *       * `CITY` → round to 1 decimal place (~11 km).
 *       * `REGION` → round to 0 decimal places (~111 km).
 *       * unset / unknown → drop lat/lon (fail closed).
 *
 * The granularity mapping treats the `locationGranularity` enum as
 * the owner's disclosure preference, not a "blur one notch further"
 * downgrade — i.e. picking EXACT means "fine, show my real lat/lon."
 * Reviewer may want to invert this to always blur one notch; PR body
 * calls it out so the call is reviewable.
 *
 * Why Scan rather than a GSI Query: `publicVisible` is a boolean
 * (two partitions — a degenerate GSI). Sdr row count is bounded by
 * the active-user count; v1 fits comfortably in a single Scan page.
 * If the table grows past a few thousand rows, switch to a sparse
 * GSI keyed by a constant `publicListPartition` attribute that
 * populates only when `publicVisible=true`.
 *
 * Dependency-injected for tests: production reads `SDR_TABLE_NAME`
 * env var; tests inject a `listSdrRows` stub that bypasses DDB.
 */

export type Granularity = 'EXACT' | 'CITY' | 'REGION';

export type SdrRow = {
  id: string;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationGranularity?: Granularity | null;
  publicVisible?: boolean | null;
  notes?: string | null;
  transmitterId?: string | null;
  ownerId?: string | null;
  deletedAt?: string | null;
  [k: string]: unknown;
};

export interface ListSdrPublicDeps {
  listSdrRows: () => Promise<SdrRow[]>;
}

let injected: Partial<ListSdrPublicDeps> = {};

export function __setDeps(deps: Partial<ListSdrPublicDeps>): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

const SDR_TABLE_NAME_ENV = 'SDR_TABLE_NAME';
const ADMIN_GROUP = 'admin';

function requireSdrTableName(): string {
  const v = process.env[SDR_TABLE_NAME_ENV];
  if (!v) {
    throw new Error(`listSdrPublicLambda: ${SDR_TABLE_NAME_ENV} env var is required`);
  }
  return v;
}

async function defaultListSdrRows(): Promise<SdrRow[]> {
  const TableName = requireSdrTableName();
  const out: SdrRow[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
  do {
    const res: ScanCommandOutput = await getDdbClient().send(
      new ScanCommand({ TableName, ExclusiveStartKey }),
    );
    for (const item of res.Items ?? []) {
      out.push(unmarshall(item) as SdrRow);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

function resolveDeps(): ListSdrPublicDeps {
  return {
    listSdrRows: injected.listSdrRows ?? defaultListSdrRows,
  };
}

function isAdmin(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf(ADMIN_GROUP) >= 0;
}

/**
 * Round a coordinate to `decimals` decimal places. Treats null /
 * undefined / non-finite inputs as missing — returns null so the
 * caller never gets a bogus 0,0.
 */
function roundCoord(n: number | null | undefined, decimals: number): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/**
 * Apply the granularity-based lat/lon blur to one Sdr row.
 *
 * "EXACT preserves full precision" matches the CLAUDE.md → Domain
 * model → SDR public visibility decision: `locationGranularity` is
 * the owner's chosen disclosure level, not a "blur one notch
 * further" downgrade. An owner who picks EXACT has explicitly
 * opted into showing real lat/lon to the public propagation map.
 * If we ever want a sanity floor (e.g. always round to 2 dp ~1 km),
 * add it inside the EXACT branch below — the test surface already
 * pins the rounding contract per-granularity.
 */
export function blurForPublic(row: SdrRow): SdrRow {
  const g = row.locationGranularity;
  const out: SdrRow = { ...row };
  if (g === 'EXACT') {
    // No blur; preserve what's stored, but normalise non-finite to null.
    out.latitude =
      typeof row.latitude === 'number' && Number.isFinite(row.latitude) ? row.latitude : null;
    out.longitude =
      typeof row.longitude === 'number' && Number.isFinite(row.longitude) ? row.longitude : null;
    return out;
  }
  if (g === 'CITY') {
    out.latitude = roundCoord(row.latitude, 1);
    out.longitude = roundCoord(row.longitude, 1);
    return out;
  }
  if (g === 'REGION') {
    out.latitude = roundCoord(row.latitude, 0);
    out.longitude = roundCoord(row.longitude, 0);
    return out;
  }
  // Unknown / unset granularity — fail closed: drop the coords entirely.
  out.latitude = null;
  out.longitude = null;
  return out;
}

export const handler: AppSyncResolverHandler<Record<string, never>, SdrRow[]> = async (event) => {
  const deps = resolveDeps();
  const rows = await deps.listSdrRows();
  const live = rows.filter((r) => !r.deletedAt);

  if (isAdmin(event.identity)) {
    return live;
  }

  return live.filter((r) => r.publicVisible === true).map(blurForPublic);
};
