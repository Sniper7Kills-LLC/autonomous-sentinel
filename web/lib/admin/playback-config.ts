'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Admin playback rate-limit tuning data layer (#114).
 *
 * Backend surface (see `amplify/data/models/playback-config.ts`):
 *   - `PlaybackConfig` model — identifier `key` (singleton row,
 *     `DEFAULT_KEY = "default"`), per-IP rate-limit knobs.
 *   - Authz: admin-only read + create/update/delete (admin knobs), so
 *     every call forces `authMode: 'userPool'` (the userPool JWT carries
 *     the `admin` group claim; identityPool group roles do not). The
 *     server enforces authorization regardless — this layer only
 *     assembles data and wires the calls.
 *
 * The signed-URL / CloudFront edge enforcement that READS this config is
 * phase 6 work (#205 / WAF) — out of scope. Likewise the STATS dashboards
 * (most-played / top users) need playback counters that don't exist yet
 * (#91 / #205); the editor ships a placeholder until those land.
 */

export const DEFAULT_KEY = 'default';

const USER_POOL = { authMode: 'userPool' as const };

/** The tunable per-IP playback rate-limit knobs. */
export interface PlaybackConfigValues {
  requestsPerMinute: number;
  bytesPerHour: number;
  signedUrlTtlSeconds: number;
}

/** CLAUDE.md-aligned starting defaults (all admin-tunable). */
export const DEFAULT_PLAYBACK_CONFIG: PlaybackConfigValues = {
  requestsPerMinute: 60,
  bytesPerHour: 1073741824, // 1 GiB
  signedUrlTtlSeconds: 300,
};

/** A loaded config row (knobs + provenance). */
export interface PlaybackConfigRow extends PlaybackConfigValues {
  key: string;
  notes: string;
  updatedAt: string | null;
}

/* --------------------------------------------------------------------- *
 * Validation (unit-tested)
 * --------------------------------------------------------------------- */

export type PlaybackFieldErrors = Partial<Record<keyof PlaybackConfigValues, string>>;

/** Raw form field values (everything arrives off number inputs as strings). */
export type PlaybackFormValues = Record<keyof PlaybackConfigValues, string>;

/** Signed-URL TTL bounds (seconds): 30s floor, 1h ceiling. */
export const TTL_MIN_SECONDS = 30;
export const TTL_MAX_SECONDS = 3600;

const INTEGER_FIELDS: (keyof PlaybackConfigValues)[] = ['requestsPerMinute', 'signedUrlTtlSeconds'];

/**
 * Validate raw form values. Returns `{ errors, input }`:
 *   - `errors` carries a message per failed field (empty = valid).
 *   - `input` is the parsed numeric payload — only meaningful when
 *     `errors` is empty.
 *
 * Rules:
 *   - every field must parse as a finite number;
 *   - `requestsPerMinute` must be a positive integer (≥ 1);
 *   - `bytesPerHour` must be a positive number (> 0);
 *   - `signedUrlTtlSeconds` must be an integer within [30, 3600].
 */
export function validatePlaybackConfig(values: PlaybackFormValues): {
  errors: PlaybackFieldErrors;
  input: PlaybackConfigValues | null;
} {
  const errors: PlaybackFieldErrors = {};
  const parsed = {} as PlaybackConfigValues;
  const keys = Object.keys(DEFAULT_PLAYBACK_CONFIG) as (keyof PlaybackConfigValues)[];

  for (const key of keys) {
    const raw = (values[key] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
      errors[key] = 'Must be a number.';
      continue;
    }
    if (INTEGER_FIELDS.includes(key) && !Number.isInteger(n)) {
      errors[key] = 'Must be a whole number.';
      continue;
    }
    parsed[key] = n;
  }

  if (errors.requestsPerMinute === undefined && parsed.requestsPerMinute < 1) {
    errors.requestsPerMinute = 'Must be at least 1 request per minute.';
  }
  if (errors.bytesPerHour === undefined && parsed.bytesPerHour <= 0) {
    errors.bytesPerHour = 'Must be greater than zero.';
  }
  if (
    errors.signedUrlTtlSeconds === undefined &&
    (parsed.signedUrlTtlSeconds < TTL_MIN_SECONDS || parsed.signedUrlTtlSeconds > TTL_MAX_SECONDS)
  ) {
    errors.signedUrlTtlSeconds = `TTL must be between ${TTL_MIN_SECONDS} and ${TTL_MAX_SECONDS} seconds.`;
  }

  if (Object.keys(errors).length > 0) {
    return { errors, input: null };
  }
  return { errors: {}, input: parsed };
}

/** Seed form strings from a loaded row (or defaults). */
export function valuesToFormValues(values: PlaybackConfigValues): PlaybackFormValues {
  const out = {} as PlaybackFormValues;
  const keys = Object.keys(DEFAULT_PLAYBACK_CONFIG) as (keyof PlaybackConfigValues)[];
  for (const key of keys) out[key] = String(values[key]);
  return out;
}

export const DEFAULT_FORM_VALUES: PlaybackFormValues = valuesToFormValues(DEFAULT_PLAYBACK_CONFIG);

/* --------------------------------------------------------------------- *
 * AppSync get / upsert wrappers
 * --------------------------------------------------------------------- */

type RawRow = Partial<Record<keyof PlaybackConfigValues, number | null>> & {
  key?: string;
  notes?: string | null;
  updatedAt?: string | null;
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

/** Coalesce a raw row into a fully-defaulted config row. */
export function toPlaybackRow(r: RawRow): PlaybackConfigRow {
  const num = (v: number | null | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    key: r.key ?? DEFAULT_KEY,
    requestsPerMinute: num(r.requestsPerMinute, DEFAULT_PLAYBACK_CONFIG.requestsPerMinute),
    bytesPerHour: num(r.bytesPerHour, DEFAULT_PLAYBACK_CONFIG.bytesPerHour),
    signedUrlTtlSeconds: num(r.signedUrlTtlSeconds, DEFAULT_PLAYBACK_CONFIG.signedUrlTtlSeconds),
    notes: r.notes ?? '',
    updatedAt: r.updatedAt ?? null,
  };
}

/**
 * Load the singleton config row. Returns `null` when the row does not
 * yet exist (first run) so the caller can seed the form with defaults and
 * create-on-first-save.
 */
export async function getPlaybackConfig(): Promise<PlaybackConfigRow | null> {
  const client = getDataClient();
  const getFn = client.models.PlaybackConfig.get as unknown as (
    input: { key: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  await resolveAuthMode();
  const raw = await getFn({ key: DEFAULT_KEY }, USER_POOL);
  throwOnErrors(raw.errors, 'getPlaybackConfig');
  return raw.data ? toPlaybackRow(raw.data) : null;
}

/**
 * Upsert the singleton config row: update when it exists, create when it
 * does not. `exists` is supplied by the caller (it already knows whether
 * `getPlaybackConfig` returned a row) to avoid a redundant read.
 */
export async function savePlaybackConfig(
  input: PlaybackConfigValues,
  opts: { exists: boolean; notes?: string },
): Promise<PlaybackConfigRow> {
  const client = getDataClient();
  const payload = { key: DEFAULT_KEY, ...input, notes: opts.notes ?? '' };
  await resolveAuthMode();
  const op = opts.exists
    ? (client.models.PlaybackConfig.update as unknown as (
        i: Record<string, unknown>,
        o?: Record<string, unknown>,
      ) => Promise<RawSingleResult>)
    : (client.models.PlaybackConfig.create as unknown as (
        i: Record<string, unknown>,
        o?: Record<string, unknown>,
      ) => Promise<RawSingleResult>);
  const raw = await op(payload, USER_POOL);
  throwOnErrors(raw.errors, 'savePlaybackConfig');
  if (!raw.data) throw new Error('savePlaybackConfig: empty response');
  return toPlaybackRow(raw.data);
}
