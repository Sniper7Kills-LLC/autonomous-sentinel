'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Admin AWS Budget threshold tuning data layer (#116).
 *
 * Backend surface (see `amplify/data/models/budget-config.ts`):
 *   - `BudgetConfig` model — identifier `key` (singleton row,
 *     `DEFAULT_KEY = "default"`), three integer USD thresholds, a
 *     notification email, and four per-tier action toggles.
 *   - Authz: admin-only read + create/update/delete (admin knobs), so
 *     every call forces `authMode: 'userPool'`. The server enforces
 *     authorization regardless — this layer only assembles data + wires
 *     the calls.
 *
 * Honest framing: the LIVE AWS Budget is defined in CDK (`amplify/budgets.ts`)
 * from the `AS_BUDGET_*` env vars at DEPLOY time and cannot read DynamoDB at
 * runtime. This config only RECORDS the intended thresholds + email +
 * actions. Pushing them into the env vars + redeploying (the sync step) and
 * live month-to-date spend display (Cost Explorer, #303) are both DEFERRED.
 *
 * `validateBudgetConfig` mirrors the CDK invariant in `budgets.ts`:
 * soft < loud < hard, positive integers, valid notification email.
 */

export const DEFAULT_KEY = 'default';

const USER_POOL = { authMode: 'userPool' as const };

/** The tunable USD thresholds (mirrors CDK `BudgetConfig` in budgets.ts). */
export interface BudgetThresholds {
  softUsd: number;
  loudUsd: number;
  hardUsd: number;
}

/** Per-tier action toggles — what happens when each threshold breaches. */
export interface BudgetActions {
  softBannerEnabled: boolean;
  loudBannerEnabled: boolean;
  hardThrottleEnabled: boolean;
  hardPageEnabled: boolean;
}

/** The full editable config (thresholds + email + actions). */
export interface BudgetConfigValues extends BudgetThresholds, BudgetActions {
  notificationEmail: string;
}

/** CLAUDE.md → Stack → Budgets defaults. */
export const DEFAULT_BUDGET_CONFIG: BudgetConfigValues = {
  softUsd: 50,
  loudUsd: 100,
  hardUsd: 200,
  notificationEmail: '',
  softBannerEnabled: false,
  loudBannerEnabled: true,
  hardThrottleEnabled: true,
  hardPageEnabled: true,
};

/** A loaded config row (values + provenance). */
export interface BudgetConfigRow extends BudgetConfigValues {
  key: string;
  notes: string;
  updatedAt: string | null;
}

const THRESHOLD_KEYS: (keyof BudgetThresholds)[] = ['softUsd', 'loudUsd', 'hardUsd'];

const ACTION_KEYS: (keyof BudgetActions)[] = [
  'softBannerEnabled',
  'loudBannerEnabled',
  'hardThrottleEnabled',
  'hardPageEnabled',
];

/* --------------------------------------------------------------------- *
 * Validation (unit-tested)
 * --------------------------------------------------------------------- */

export type BudgetFieldErrors = Partial<
  Record<keyof BudgetThresholds | 'notificationEmail', string>
>;

/** Raw form values: thresholds + email arrive as strings, actions as booleans. */
export interface BudgetFormValues extends BudgetActions {
  softUsd: string;
  loudUsd: string;
  hardUsd: string;
  notificationEmail: string;
}

// Pragmatic single-line email check — the CDK side does no validation, so a
// reasonable client gate is enough; SES is the real authority on deliverability.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate raw form values. Returns `{ errors, input }`:
 *   - `errors` carries a message per failed field (empty = valid).
 *   - `input` is the parsed payload — only meaningful when `errors` is empty.
 *
 * Rules (mirror the CDK invariant in `amplify/budgets.ts`):
 *   - each threshold must parse as a positive integer;
 *   - soft < loud < hard;
 *   - notification email must be a valid address.
 */
export function validateBudgetConfig(values: BudgetFormValues): {
  errors: BudgetFieldErrors;
  input: BudgetConfigValues | null;
} {
  const errors: BudgetFieldErrors = {};
  const parsed = {} as BudgetThresholds;

  for (const key of THRESHOLD_KEYS) {
    const raw = (values[key] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) {
      errors[key] = 'Must be a number.';
      continue;
    }
    if (!Number.isInteger(n)) {
      errors[key] = 'Must be a whole dollar amount.';
      continue;
    }
    if (n <= 0) {
      errors[key] = 'Must be greater than zero.';
      continue;
    }
    parsed[key] = n;
  }

  // Ordering invariant: soft < loud < hard. Only check when each side parsed.
  if (
    errors.softUsd === undefined &&
    errors.loudUsd === undefined &&
    parsed.softUsd >= parsed.loudUsd
  ) {
    errors.loudUsd = 'Loud must be greater than soft.';
  }
  if (
    errors.loudUsd === undefined &&
    errors.hardUsd === undefined &&
    parsed.loudUsd >= parsed.hardUsd
  ) {
    errors.hardUsd = 'Hard must be greater than loud.';
  }

  const email = (values.notificationEmail ?? '').trim();
  if (email === '' || !EMAIL_RE.test(email)) {
    errors.notificationEmail = 'Must be a valid email address.';
  }

  if (Object.keys(errors).length > 0) {
    return { errors, input: null };
  }

  return {
    errors: {},
    input: {
      ...parsed,
      notificationEmail: email,
      softBannerEnabled: values.softBannerEnabled,
      loudBannerEnabled: values.loudBannerEnabled,
      hardThrottleEnabled: values.hardThrottleEnabled,
      hardPageEnabled: values.hardPageEnabled,
    },
  };
}

/** Seed form values from a loaded config (or defaults). */
export function valuesToFormValues(values: BudgetConfigValues): BudgetFormValues {
  return {
    softUsd: String(values.softUsd),
    loudUsd: String(values.loudUsd),
    hardUsd: String(values.hardUsd),
    notificationEmail: values.notificationEmail,
    softBannerEnabled: values.softBannerEnabled,
    loudBannerEnabled: values.loudBannerEnabled,
    hardThrottleEnabled: values.hardThrottleEnabled,
    hardPageEnabled: values.hardPageEnabled,
  };
}

export const DEFAULT_FORM_VALUES: BudgetFormValues = valuesToFormValues(DEFAULT_BUDGET_CONFIG);

/* --------------------------------------------------------------------- *
 * AppSync get / upsert wrappers
 * --------------------------------------------------------------------- */

type RawRow = {
  key?: string;
  softUsd?: number | null;
  loudUsd?: number | null;
  hardUsd?: number | null;
  notificationEmail?: string | null;
  softBannerEnabled?: boolean | null;
  loudBannerEnabled?: boolean | null;
  hardThrottleEnabled?: boolean | null;
  hardPageEnabled?: boolean | null;
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
export function toBudgetRow(r: RawRow): BudgetConfigRow {
  const int = (v: number | null | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const bool = (v: boolean | null | undefined, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;
  return {
    key: r.key ?? DEFAULT_KEY,
    softUsd: int(r.softUsd, DEFAULT_BUDGET_CONFIG.softUsd),
    loudUsd: int(r.loudUsd, DEFAULT_BUDGET_CONFIG.loudUsd),
    hardUsd: int(r.hardUsd, DEFAULT_BUDGET_CONFIG.hardUsd),
    notificationEmail: r.notificationEmail ?? DEFAULT_BUDGET_CONFIG.notificationEmail,
    softBannerEnabled: bool(r.softBannerEnabled, DEFAULT_BUDGET_CONFIG.softBannerEnabled),
    loudBannerEnabled: bool(r.loudBannerEnabled, DEFAULT_BUDGET_CONFIG.loudBannerEnabled),
    hardThrottleEnabled: bool(r.hardThrottleEnabled, DEFAULT_BUDGET_CONFIG.hardThrottleEnabled),
    hardPageEnabled: bool(r.hardPageEnabled, DEFAULT_BUDGET_CONFIG.hardPageEnabled),
    notes: r.notes ?? '',
    updatedAt: r.updatedAt ?? null,
  };
}

/**
 * Load the singleton config row. Returns `null` when the row does not yet
 * exist (first run) so the caller can seed the form with defaults and
 * create-on-first-save.
 */
export async function getBudgetConfig(): Promise<BudgetConfigRow | null> {
  const client = getDataClient();
  const getFn = client.models.BudgetConfig.get as unknown as (
    input: { key: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  await resolveAuthMode();
  const raw = await getFn({ key: DEFAULT_KEY }, USER_POOL);
  throwOnErrors(raw.errors, 'getBudgetConfig');
  return raw.data ? toBudgetRow(raw.data) : null;
}

/**
 * Upsert the singleton config row: update when it exists, create when it does
 * not. `exists` is supplied by the caller (it already knows whether
 * `getBudgetConfig` returned a row) to avoid a redundant read.
 */
export async function saveBudgetConfig(
  input: BudgetConfigValues,
  opts: { exists: boolean; notes?: string },
): Promise<BudgetConfigRow> {
  const client = getDataClient();
  const payload = { key: DEFAULT_KEY, ...input, notes: opts.notes ?? '' };
  await resolveAuthMode();
  const op = opts.exists
    ? (client.models.BudgetConfig.update as unknown as (
        i: Record<string, unknown>,
        o?: Record<string, unknown>,
      ) => Promise<RawSingleResult>)
    : (client.models.BudgetConfig.create as unknown as (
        i: Record<string, unknown>,
        o?: Record<string, unknown>,
      ) => Promise<RawSingleResult>);
  const raw = await op(payload, USER_POOL);
  throwOnErrors(raw.errors, 'saveBudgetConfig');
  if (!raw.data) throw new Error('saveBudgetConfig: empty response');
  return toBudgetRow(raw.data);
}

export { ACTION_KEYS, THRESHOLD_KEYS };
