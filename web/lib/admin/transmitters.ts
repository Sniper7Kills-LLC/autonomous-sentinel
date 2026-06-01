'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Admin transmitter editor data layer (#108).
 *
 * Backend surface (see `amplify/data/models/transmitter.ts`):
 *   - `Transmitter` model — fields `name` (required), `latitude` /
 *     `longitude` (required float), `callsign`, `frequencyKhzList`
 *     (int array), `notes`.
 *   - Authz: `allow.guest().to(['read'])` +
 *     `allow.groups(['admin']).to(['read','create','update','delete'])`.
 *     Note: NOT moderator — create/update/delete is admin-only.
 *
 * Reads can run under either auth mode (guest read is granted), but the
 * mutations only pass under the User Pool JWT carrying the `admin` group
 * claim, so every mutation forces `authMode: 'userPool'` (mirrors
 * `web/lib/comments/query.ts` + `web/lib/admin/moderation.ts`). The list
 * resolves the session auth mode the same way `web/lib/admin/audit.ts`
 * does. The server enforces authorization regardless — this layer only
 * assembles data and wires the calls.
 *
 * Map preview / click-to-set lat/lon picker is DEFERRED to #83 (the
 * propagation map work owns the `maplibre-gl` dependency); this editor
 * uses plain numeric lat/lon inputs at v1.
 */

const USER_POOL = { authMode: 'userPool' as const };

/** A single Transmitter row, normalized for the editor. */
export interface TransmitterRow {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  callsign: string | null;
  frequencyKhzList: number[];
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Validated input payload for a create / update. */
export interface TransmitterInput {
  name: string;
  latitude: number;
  longitude: number;
  callsign: string | null;
  frequencyKhzList: number[];
  notes: string | null;
}

/** Raw form field values (strings straight off the inputs). */
export interface TransmitterFormValues {
  name: string;
  latitude: string;
  longitude: string;
  callsign: string;
  frequencyKhzList: string;
  notes: string;
}

/** Field-keyed validation errors (only present keys failed). */
export type TransmitterFieldErrors = Partial<
  Record<'name' | 'latitude' | 'longitude' | 'frequencyKhzList', string>
>;

type RawRow = {
  id: string;
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  callsign?: string | null;
  frequencyKhzList?: (number | null)[] | null;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type RawListResult = {
  data?: RawRow[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

type RawSingleResult = {
  data?: RawRow | null;
  errors?: { message: string }[] | null;
};

function throwOnErrors(errors: { message: string }[] | null | undefined, op: string): void {
  if (errors && errors.length > 0) {
    throw new Error(`${op} failed: ${errors.map((e) => e.message).join('; ')}`);
  }
}

export function toTransmitterRow(r: RawRow): TransmitterRow {
  return {
    id: r.id,
    name: r.name ?? '',
    latitude: typeof r.latitude === 'number' ? r.latitude : null,
    longitude: typeof r.longitude === 'number' ? r.longitude : null,
    callsign: r.callsign ?? null,
    frequencyKhzList: (r.frequencyKhzList ?? []).filter(
      (n): n is number => typeof n === 'number' && Number.isFinite(n),
    ),
    notes: r.notes ?? null,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  };
}

/* --------------------------------------------------------------------- *
 * Pure parse + validation (unit-tested)
 * --------------------------------------------------------------------- */

/**
 * Parse a comma / whitespace-separated list of frequencies (kHz) into a
 * deduped array of positive integers, preserving first-seen order.
 * Non-integer / non-positive / unparseable tokens are dropped silently;
 * `validateTransmitterInput` is responsible for flagging malformed input
 * to the user.
 */
export function parseFrequencyList(raw: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const token of (raw ?? '').split(/[\s,]+/)) {
    const t = token.trim();
    if (!t) continue;
    if (!/^\d+$/.test(t)) continue;
    const n = Number.parseInt(t, 10);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** True when every non-empty token in `raw` is a positive integer. */
function frequencyTokensAllValid(raw: string): boolean {
  for (const token of (raw ?? '').split(/[\s,]+/)) {
    const t = token.trim();
    if (!t) continue;
    if (!/^\d+$/.test(t) || Number.parseInt(t, 10) <= 0) return false;
  }
  return true;
}

/**
 * Validate raw form values. Returns `{ errors, input }`:
 *   - `errors` carries a message per failed field (empty object = valid).
 *   - `input` is the cleaned, typed payload — only meaningful when
 *     `errors` is empty.
 *
 * Rules:
 *   - name: required (non-blank after trim).
 *   - latitude: required, numeric, −90..90.
 *   - longitude: required, numeric, −180..180.
 *   - frequencyKhzList: every token must be a positive integer (blank ok).
 *   - callsign / notes: optional, trimmed; blank → null.
 */
export function validateTransmitterInput(values: TransmitterFormValues): {
  errors: TransmitterFieldErrors;
  input: TransmitterInput | null;
} {
  const errors: TransmitterFieldErrors = {};

  const name = (values.name ?? '').trim();
  if (!name) errors.name = 'Name is required.';

  const lat = Number(values.latitude);
  if ((values.latitude ?? '').trim() === '' || Number.isNaN(lat)) {
    errors.latitude = 'Latitude is required and must be a number.';
  } else if (lat < -90 || lat > 90) {
    errors.latitude = 'Latitude must be between −90 and 90.';
  }

  const lon = Number(values.longitude);
  if ((values.longitude ?? '').trim() === '' || Number.isNaN(lon)) {
    errors.longitude = 'Longitude is required and must be a number.';
  } else if (lon < -180 || lon > 180) {
    errors.longitude = 'Longitude must be between −180 and 180.';
  }

  if (!frequencyTokensAllValid(values.frequencyKhzList)) {
    errors.frequencyKhzList = 'Frequencies must be positive whole numbers (kHz).';
  }

  if (Object.keys(errors).length > 0) {
    return { errors, input: null };
  }

  const callsign = (values.callsign ?? '').trim();
  const notes = (values.notes ?? '').trim();
  return {
    errors: {},
    input: {
      name,
      latitude: lat,
      longitude: lon,
      callsign: callsign ? callsign.toUpperCase() : null,
      frequencyKhzList: parseFrequencyList(values.frequencyKhzList),
      notes: notes || null,
    },
  };
}

/** Form values seeded from an existing row (for the edit form). */
export function rowToFormValues(row: TransmitterRow): TransmitterFormValues {
  return {
    name: row.name,
    latitude: row.latitude == null ? '' : String(row.latitude),
    longitude: row.longitude == null ? '' : String(row.longitude),
    callsign: row.callsign ?? '',
    frequencyKhzList: row.frequencyKhzList.join(', '),
    notes: row.notes ?? '',
  };
}

export const EMPTY_FORM_VALUES: TransmitterFormValues = {
  name: '',
  latitude: '',
  longitude: '',
  callsign: '',
  frequencyKhzList: '',
  notes: '',
};

/* --------------------------------------------------------------------- *
 * AppSync CRUD wrappers
 * --------------------------------------------------------------------- */

export async function listTransmitters(): Promise<TransmitterRow[]> {
  const client = getDataClient();
  const listFn = client.models.Transmitter.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const raw = await listFn({ authMode });
  throwOnErrors(raw.errors, 'listTransmitters');
  const rows = (raw.data ?? []).map(toTransmitterRow);
  // Alphabetical by name for a stable editor table (list order is not
  // guaranteed by AppSync).
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export async function createTransmitter(input: TransmitterInput): Promise<TransmitterRow> {
  const client = getDataClient();
  const createFn = client.models.Transmitter.create as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await createFn({ ...input }, USER_POOL);
  throwOnErrors(raw.errors, 'createTransmitter');
  if (!raw.data) throw new Error('createTransmitter: empty response');
  return toTransmitterRow(raw.data);
}

export async function updateTransmitter(
  id: string,
  input: TransmitterInput,
): Promise<TransmitterRow> {
  const client = getDataClient();
  const updateFn = client.models.Transmitter.update as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await updateFn({ id, ...input }, USER_POOL);
  throwOnErrors(raw.errors, 'updateTransmitter');
  if (!raw.data) throw new Error('updateTransmitter: empty response');
  return toTransmitterRow(raw.data);
}

export async function deleteTransmitter(id: string): Promise<void> {
  const client = getDataClient();
  const deleteFn = client.models.Transmitter.delete as unknown as (
    input: { id: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await deleteFn({ id }, USER_POOL);
  throwOnErrors(raw.errors, 'deleteTransmitter');
}
