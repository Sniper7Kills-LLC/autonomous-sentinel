'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Admin reputation / vote-weight formula tuning data layer (#117).
 *
 * Backend surface (see `amplify/data/models/reputation-config.ts`):
 *   - `ReputationConfig` model — identifier `key` (singleton row,
 *     `DEFAULT_KEY = "default"`), one float/integer field per CLAUDE.md
 *     formula coefficient.
 *   - Authz: admin-only read + create/update/delete (admin knobs), so
 *     every call forces `authMode: 'userPool'` (the userPool JWT carries
 *     the `admin` group claim; identityPool group roles do not). The
 *     server enforces authorization regardless — this layer only
 *     assembles data and wires the calls.
 *
 * The Lambda that APPLIES this formula to Reputation rows (recompute on
 * publish / accept) is #480 — out of scope. `computeWeight` here is the
 * single pure source of truth for the formula, reused by the admin
 * preview pane and (later) by #480.
 */

export const DEFAULT_KEY = 'default';

const USER_POOL = { authMode: 'userPool' as const };

/** The tunable coefficients of the CLAUDE.md vote-weight formula. */
export interface ReputationConfigValues {
  base: number;
  perValidatedSubmission: number;
  validatedCap: number;
  perAcceptedCorrection: number;
  correctionCap: number;
  moderatorBonus: number;
  adminBonus: number;
  netWeightCap: number;
  quorum: number;
  confidenceThreshold: number;
}

/** CLAUDE.md → Domain model → Vote defaults. */
export const DEFAULT_REPUTATION_CONFIG: ReputationConfigValues = {
  base: 1,
  perValidatedSubmission: 0.1,
  validatedCap: 4,
  perAcceptedCorrection: 0.5,
  correctionCap: 5,
  moderatorBonus: 1,
  adminBonus: 2,
  netWeightCap: 5,
  quorum: 2,
  confidenceThreshold: 0.8,
};

/** A loaded config row (coefficients + provenance). */
export interface ReputationConfigRow extends ReputationConfigValues {
  key: string;
  notes: string;
  updatedAt: string | null;
}

export type UserRole = 'member' | 'moderator' | 'admin';

/** Sample-user inputs the preview pane feeds into `computeWeight`. */
export interface WeightInputs {
  validatedSubmissions: number;
  acceptedCorrections: number;
  role: UserRole;
}

/* --------------------------------------------------------------------- *
 * Pure formula (unit-tested) — the single source of truth.
 * --------------------------------------------------------------------- */

/**
 * Compute a user's reputation weight from the CLAUDE.md formula:
 *
 *   weight = base
 *          + perValidatedSubmission * min(validatedSubmissions, validatedCap)
 *          + perAcceptedCorrection  * min(acceptedCorrections,  correctionCap)
 *          + (role === 'moderator' ? moderatorBonus : 0)
 *          + (role === 'admin'     ? adminBonus     : 0)
 *   weight = min(weight, netWeightCap)
 *
 * Counts are clamped to be non-negative before the cap is applied so a
 * stray negative input cannot reduce weight below `base`. The net cap is
 * applied last.
 */
export function computeWeight(config: ReputationConfigValues, inputs: WeightInputs): number {
  const validated = Math.min(Math.max(inputs.validatedSubmissions, 0), config.validatedCap);
  const corrections = Math.min(Math.max(inputs.acceptedCorrections, 0), config.correctionCap);

  let weight =
    config.base +
    config.perValidatedSubmission * validated +
    config.perAcceptedCorrection * corrections;

  if (inputs.role === 'moderator') weight += config.moderatorBonus;
  if (inputs.role === 'admin') weight += config.adminBonus;

  return Math.min(weight, config.netWeightCap);
}

/* --------------------------------------------------------------------- *
 * Validation (unit-tested)
 * --------------------------------------------------------------------- */

export type ReputationFieldErrors = Partial<Record<keyof ReputationConfigValues, string>>;

/** Raw form field values (everything arrives off number inputs as strings). */
export type ReputationFormValues = Record<keyof ReputationConfigValues, string>;

const NON_NEGATIVE: (keyof ReputationConfigValues)[] = [
  'base',
  'perValidatedSubmission',
  'validatedCap',
  'perAcceptedCorrection',
  'correctionCap',
  'moderatorBonus',
  'adminBonus',
];

const INTEGER_FIELDS: (keyof ReputationConfigValues)[] = ['validatedCap', 'correctionCap'];

/**
 * Validate raw form values. Returns `{ errors, input }`:
 *   - `errors` carries a message per failed field (empty = valid).
 *   - `input` is the parsed numeric payload — only meaningful when
 *     `errors` is empty.
 *
 * Rules:
 *   - every field must parse as a finite number;
 *   - bonuses + caps may not be negative (no negative reputation gain);
 *   - caps are integers (you cannot validate 4.5 submissions);
 *   - `netWeightCap` must be ≥ `base` (the cap can't sit below the floor);
 *   - `quorum` must be > 0;
 *   - `confidenceThreshold` must be within [0, 1].
 */
export function validateReputationConfig(values: ReputationFormValues): {
  errors: ReputationFieldErrors;
  input: ReputationConfigValues | null;
} {
  const errors: ReputationFieldErrors = {};
  const parsed = {} as ReputationConfigValues;
  const keys = Object.keys(DEFAULT_REPUTATION_CONFIG) as (keyof ReputationConfigValues)[];

  for (const key of keys) {
    const raw = (values[key] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
      errors[key] = 'Must be a number.';
      continue;
    }
    if (NON_NEGATIVE.includes(key) && n < 0) {
      errors[key] = 'Must not be negative.';
      continue;
    }
    if (INTEGER_FIELDS.includes(key) && !Number.isInteger(n)) {
      errors[key] = 'Must be a whole number.';
      continue;
    }
    parsed[key] = n;
  }

  if (errors.quorum === undefined && parsed.quorum <= 0) {
    errors.quorum = 'Quorum must be greater than zero.';
  }
  if (
    errors.confidenceThreshold === undefined &&
    (parsed.confidenceThreshold < 0 || parsed.confidenceThreshold > 1)
  ) {
    errors.confidenceThreshold = 'Confidence threshold must be between 0 and 1.';
  }
  if (
    errors.netWeightCap === undefined &&
    errors.base === undefined &&
    parsed.netWeightCap < parsed.base
  ) {
    errors.netWeightCap = 'Net weight cap must be at least the base weight.';
  }

  if (Object.keys(errors).length > 0) {
    return { errors, input: null };
  }
  return { errors: {}, input: parsed };
}

/** Seed form strings from a loaded row (or defaults). */
export function valuesToFormValues(values: ReputationConfigValues): ReputationFormValues {
  const out = {} as ReputationFormValues;
  const keys = Object.keys(DEFAULT_REPUTATION_CONFIG) as (keyof ReputationConfigValues)[];
  for (const key of keys) out[key] = String(values[key]);
  return out;
}

export const DEFAULT_FORM_VALUES: ReputationFormValues =
  valuesToFormValues(DEFAULT_REPUTATION_CONFIG);

/* --------------------------------------------------------------------- *
 * AppSync get / upsert wrappers
 * --------------------------------------------------------------------- */

type RawRow = Partial<Record<keyof ReputationConfigValues, number | null>> & {
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
export function toReputationRow(r: RawRow): ReputationConfigRow {
  const num = (v: number | null | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    key: r.key ?? DEFAULT_KEY,
    base: num(r.base, DEFAULT_REPUTATION_CONFIG.base),
    perValidatedSubmission: num(
      r.perValidatedSubmission,
      DEFAULT_REPUTATION_CONFIG.perValidatedSubmission,
    ),
    validatedCap: num(r.validatedCap, DEFAULT_REPUTATION_CONFIG.validatedCap),
    perAcceptedCorrection: num(
      r.perAcceptedCorrection,
      DEFAULT_REPUTATION_CONFIG.perAcceptedCorrection,
    ),
    correctionCap: num(r.correctionCap, DEFAULT_REPUTATION_CONFIG.correctionCap),
    moderatorBonus: num(r.moderatorBonus, DEFAULT_REPUTATION_CONFIG.moderatorBonus),
    adminBonus: num(r.adminBonus, DEFAULT_REPUTATION_CONFIG.adminBonus),
    netWeightCap: num(r.netWeightCap, DEFAULT_REPUTATION_CONFIG.netWeightCap),
    quorum: num(r.quorum, DEFAULT_REPUTATION_CONFIG.quorum),
    confidenceThreshold: num(r.confidenceThreshold, DEFAULT_REPUTATION_CONFIG.confidenceThreshold),
    notes: r.notes ?? '',
    updatedAt: r.updatedAt ?? null,
  };
}

/**
 * Load the singleton config row. Returns `null` when the row does not
 * yet exist (first run) so the caller can seed the form with defaults and
 * create-on-first-save.
 */
export async function getReputationConfig(): Promise<ReputationConfigRow | null> {
  const client = getDataClient();
  const getFn = client.models.ReputationConfig.get as unknown as (
    input: { key: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  await resolveAuthMode();
  const raw = await getFn({ key: DEFAULT_KEY }, USER_POOL);
  throwOnErrors(raw.errors, 'getReputationConfig');
  return raw.data ? toReputationRow(raw.data) : null;
}

/**
 * Upsert the singleton config row: update when it exists, create when it
 * does not. `exists` is supplied by the caller (it already knows whether
 * `getReputationConfig` returned a row) to avoid a redundant read.
 */
export async function saveReputationConfig(
  input: ReputationConfigValues,
  opts: { exists: boolean; notes?: string },
): Promise<ReputationConfigRow> {
  const client = getDataClient();
  const payload = { key: DEFAULT_KEY, ...input, notes: opts.notes ?? '' };
  await resolveAuthMode();
  const op = opts.exists
    ? (client.models.ReputationConfig.update as unknown as (
        i: Record<string, unknown>,
        o?: Record<string, unknown>,
      ) => Promise<RawSingleResult>)
    : (client.models.ReputationConfig.create as unknown as (
        i: Record<string, unknown>,
        o?: Record<string, unknown>,
      ) => Promise<RawSingleResult>);
  const raw = await op(payload, USER_POOL);
  throwOnErrors(raw.errors, 'saveReputationConfig');
  if (!raw.data) throw new Error('saveReputationConfig: empty response');
  return toReputationRow(raw.data);
}
