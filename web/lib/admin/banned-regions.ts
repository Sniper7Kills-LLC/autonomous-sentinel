'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Admin banned-region landing-page editor data layer (#113).
 *
 * Backend surface (see `amplify/data/models/banned-region-page.ts`):
 *   - `BannedRegionPage` model — identifier `countryCode` (ISO-3166-1
 *     alpha-2), fields `title` (required), `bodyMarkdown` (required),
 *     `enabled` (boolean, default true). No separate `id` — the country
 *     code IS the primary key, so create / update / delete all key off
 *     `countryCode`.
 *   - Authz: `allow.guest().to(['read'])` +
 *     `allow.groups(['admin']).to(['read','create','update','delete'])`.
 *     Note: NOT moderator — create/update/delete is admin-only.
 *
 * Reads can run under either auth mode (guest read is granted), but the
 * mutations only pass under the User Pool JWT carrying the `admin` group
 * claim, so every mutation forces `authMode: 'userPool'` (mirrors
 * `web/lib/admin/transmitters.ts`). The list resolves the session auth
 * mode the same way. The server enforces authorization regardless — this
 * layer only assembles data and wires the calls.
 *
 * Public serving of the rendered page to blocked visitors is DEFERRED to
 * #202 (infra / WAF custom-response). This module is the admin EDITOR
 * only.
 */

const USER_POOL = { authMode: 'userPool' as const };

/** A single BannedRegionPage row, normalized for the editor. */
export interface BannedRegionRow {
  countryCode: string;
  title: string;
  bodyMarkdown: string;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Validated input payload for a create / update. */
export interface BannedRegionInput {
  countryCode: string;
  title: string;
  bodyMarkdown: string;
  enabled: boolean;
}

/** Raw form field values (strings / bool straight off the inputs). */
export interface BannedRegionFormValues {
  countryCode: string;
  title: string;
  bodyMarkdown: string;
  enabled: boolean;
}

/** Field-keyed validation errors (only present keys failed). */
export type BannedRegionFieldErrors = Partial<
  Record<'countryCode' | 'title' | 'bodyMarkdown', string>
>;

type RawRow = {
  countryCode: string;
  title?: string | null;
  bodyMarkdown?: string | null;
  enabled?: boolean | null;
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

export function toBannedRegionRow(r: RawRow): BannedRegionRow {
  return {
    countryCode: r.countryCode,
    title: r.title ?? '',
    bodyMarkdown: r.bodyMarkdown ?? '',
    // Model default is true; treat a nullish flag as enabled.
    enabled: r.enabled !== false,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  };
}

/* --------------------------------------------------------------------- *
 * Pure parse + validation (unit-tested)
 * --------------------------------------------------------------------- */

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

/**
 * Normalize then validate an ISO-3166-1 alpha-2 country code. Returns the
 * upper-cased two-letter code when valid, or `null` otherwise. Surrounding
 * whitespace is trimmed and the input is upper-cased before the test, so
 * `" us "` → `"US"`.
 */
export function validateCountryCode(raw: string): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return COUNTRY_CODE_RE.test(code) ? code : null;
}

/**
 * Validate raw form values. Returns `{ errors, input }`:
 *   - `errors` carries a message per failed field (empty object = valid).
 *   - `input` is the cleaned, typed payload — only meaningful when
 *     `errors` is empty.
 *
 * Rules:
 *   - countryCode: required; exactly two A–Z letters (case-insensitive in,
 *     upper-cased out).
 *   - title: required (non-blank after trim).
 *   - bodyMarkdown: required (non-blank after trim).
 *   - enabled: boolean, passed through.
 */
export function validateBannedRegionInput(values: BannedRegionFormValues): {
  errors: BannedRegionFieldErrors;
  input: BannedRegionInput | null;
} {
  const errors: BannedRegionFieldErrors = {};

  const code = validateCountryCode(values.countryCode);
  if ((values.countryCode ?? '').trim() === '') {
    errors.countryCode = 'Country code is required.';
  } else if (!code) {
    errors.countryCode = 'Country code must be two letters (ISO-3166-1 alpha-2).';
  }

  const title = (values.title ?? '').trim();
  if (!title) errors.title = 'Title is required.';

  const bodyMarkdown = (values.bodyMarkdown ?? '').trim();
  if (!bodyMarkdown) errors.bodyMarkdown = 'Body markdown is required.';

  if (Object.keys(errors).length > 0 || !code) {
    return { errors, input: null };
  }

  return {
    errors: {},
    input: {
      countryCode: code,
      title,
      bodyMarkdown,
      enabled: Boolean(values.enabled),
    },
  };
}

/** Form values seeded from an existing row (for the edit form). */
export function rowToFormValues(row: BannedRegionRow): BannedRegionFormValues {
  return {
    countryCode: row.countryCode,
    title: row.title,
    bodyMarkdown: row.bodyMarkdown,
    enabled: row.enabled,
  };
}

export const EMPTY_FORM_VALUES: BannedRegionFormValues = {
  countryCode: '',
  title: '',
  bodyMarkdown: '',
  enabled: true,
};

/* --------------------------------------------------------------------- *
 * AppSync CRUD wrappers
 * --------------------------------------------------------------------- */

export async function listBannedRegionPages(): Promise<BannedRegionRow[]> {
  const client = getDataClient();
  const listFn = client.models.BannedRegionPage.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const raw = await listFn({ authMode });
  throwOnErrors(raw.errors, 'listBannedRegionPages');
  const rows = (raw.data ?? []).map(toBannedRegionRow);
  // Alphabetical by country code for a stable editor table (list order is
  // not guaranteed by AppSync).
  rows.sort((a, b) => a.countryCode.localeCompare(b.countryCode));
  return rows;
}

export async function createBannedRegionPage(input: BannedRegionInput): Promise<BannedRegionRow> {
  const client = getDataClient();
  const createFn = client.models.BannedRegionPage.create as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await createFn({ ...input }, USER_POOL);
  throwOnErrors(raw.errors, 'createBannedRegionPage');
  if (!raw.data) throw new Error('createBannedRegionPage: empty response');
  return toBannedRegionRow(raw.data);
}

export async function updateBannedRegionPage(input: BannedRegionInput): Promise<BannedRegionRow> {
  const client = getDataClient();
  const updateFn = client.models.BannedRegionPage.update as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await updateFn({ ...input }, USER_POOL);
  throwOnErrors(raw.errors, 'updateBannedRegionPage');
  if (!raw.data) throw new Error('updateBannedRegionPage: empty response');
  return toBannedRegionRow(raw.data);
}

export async function deleteBannedRegionPage(countryCode: string): Promise<void> {
  const client = getDataClient();
  const deleteFn = client.models.BannedRegionPage.delete as unknown as (
    input: { countryCode: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await deleteFn({ countryCode }, USER_POOL);
  throwOnErrors(raw.errors, 'deleteBannedRegionPage');
}
