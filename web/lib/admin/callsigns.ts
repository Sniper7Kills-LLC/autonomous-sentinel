'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Admin callsign-dictionary data layer (#109).
 *
 * Backend surface (see `amplify/data/models/callsign.ts`):
 *   - `Callsign` model — fields `normalized` (required string),
 *     `variants` (string array), `source` enum
 *     (`LEGACY` / `ADMIN` / `AI_SUGGESTED`), `confidence` (float),
 *     `approved` (bool, default true), `notes`.
 *   - Authz: `allow.guest().to(['read'])` +
 *     `allow.groups(['admin']).to(['read','create','update','delete'])`.
 *     Note: NOT moderator — create/update/delete is admin-only.
 *
 * Reads can run under either auth mode (guest read is granted), so the
 * list resolves the session auth mode (mirrors `web/lib/admin/audit.ts`).
 * Mutations only pass under the User Pool JWT carrying the `admin` group
 * claim, so every mutation forces `authMode: 'userPool'` (mirrors
 * `web/lib/admin/transmitters.ts`). The server enforces authorization
 * regardless — this layer only assembles data and wires the calls.
 *
 * DEFERRED — the AI/Bedrock dedup *suggestion generation* (the pass that
 * scans the dictionary, auto-merges above a confidence threshold, and
 * queues lower-confidence merges as `source='AI_SUGGESTED'` rows) needs
 * a Bedrock Lambda and is OUT OF SCOPE here. See the migration / Bedrock
 * work (#172, #173). This PR is the human dictionary CRUD plus the
 * merge-queue *review* UI: those `AI_SUGGESTED` rows are plain model data
 * that an admin approves (set `approved=true`) or rejects (delete).
 */

const USER_POOL = { authMode: 'userPool' as const };

/** Callsign dictionary sources (mirrors the model enum). */
export type CallsignSource = 'LEGACY' | 'ADMIN' | 'AI_SUGGESTED';

/** A single Callsign row, normalized for the editor. */
export interface CallsignRow {
  id: string;
  normalized: string;
  variants: string[];
  source: CallsignSource | null;
  confidence: number | null;
  approved: boolean;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Validated input payload for a create / update. */
export interface CallsignInput {
  normalized: string;
  variants: string[];
  source: CallsignSource;
  approved: boolean;
  notes: string | null;
}

/** Raw form field values (strings / bool straight off the inputs). */
export interface CallsignFormValues {
  normalized: string;
  variants: string;
  source: CallsignSource;
  approved: boolean;
  notes: string;
}

/** Field-keyed validation errors (only present keys failed). */
export type CallsignFieldErrors = Partial<Record<'normalized', string>>;

type RawRow = {
  id: string;
  normalized?: string | null;
  variants?: (string | null)[] | null;
  source?: string | null;
  confidence?: number | null;
  approved?: boolean | null;
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

function normalizeSource(s: string | null | undefined): CallsignSource | null {
  return s === 'LEGACY' || s === 'ADMIN' || s === 'AI_SUGGESTED' ? s : null;
}

export function toCallsignRow(r: RawRow): CallsignRow {
  return {
    id: r.id,
    normalized: r.normalized ?? '',
    variants: (r.variants ?? []).filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    ),
    source: normalizeSource(r.source),
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    // Model default is true; treat a missing value as approved.
    approved: r.approved !== false,
    notes: r.notes ?? null,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  };
}

/* --------------------------------------------------------------------- *
 * Pure parse + validation (unit-tested)
 * --------------------------------------------------------------------- */

/**
 * Parse a comma / newline-separated list of callsign variants into a
 * deduped, uppercased array, preserving first-seen order.
 *
 * Variants are split on COMMAS and NEWLINES only — NOT on spaces —
 * because callsign variants are legitimately multi-word ("SKY KING",
 * "ANY AIRBORNE COMMAND"). Each token is trimmed, internal runs of
 * whitespace collapse to a single space, and the result is uppercased.
 * Empty tokens are dropped; deduping is case-insensitive (values are
 * uppercased before comparison).
 */
export function parseVariants(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of (raw ?? '').split(/[,\n]+/)) {
    const t = token.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Validate raw form values. Returns `{ errors, input }`:
 *   - `errors` carries a message per failed field (empty object = valid).
 *   - `input` is the cleaned, typed payload — only meaningful when
 *     `errors` is empty.
 *
 * Rules:
 *   - normalized: required (non-blank after trim); uppercased + trimmed.
 *   - variants: parsed via `parseVariants` (deduped, uppercased).
 *   - source: passed through (defaults ADMIN on create at the form level).
 *   - notes: optional, trimmed; blank → null.
 */
export function validateCallsignInput(values: CallsignFormValues): {
  errors: CallsignFieldErrors;
  input: CallsignInput | null;
} {
  const errors: CallsignFieldErrors = {};

  const normalized = (values.normalized ?? '').trim().toUpperCase();
  if (!normalized) errors.normalized = 'Normalized callsign is required.';

  if (Object.keys(errors).length > 0) {
    return { errors, input: null };
  }

  const notes = (values.notes ?? '').trim();
  return {
    errors: {},
    input: {
      normalized,
      variants: parseVariants(values.variants),
      source: values.source,
      approved: values.approved,
      notes: notes || null,
    },
  };
}

/** Form values seeded from an existing row (for the edit form). */
export function rowToFormValues(row: CallsignRow): CallsignFormValues {
  return {
    normalized: row.normalized,
    variants: row.variants.join(', '),
    source: row.source ?? 'ADMIN',
    approved: row.approved,
    notes: row.notes ?? '',
  };
}

export const EMPTY_FORM_VALUES: CallsignFormValues = {
  normalized: '',
  variants: '',
  source: 'ADMIN',
  approved: true,
  notes: '',
};

/* --------------------------------------------------------------------- *
 * AppSync CRUD wrappers
 * --------------------------------------------------------------------- */

export async function listCallsigns(): Promise<CallsignRow[]> {
  const client = getDataClient();
  const listFn = client.models.Callsign.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const raw = await listFn({ authMode });
  throwOnErrors(raw.errors, 'listCallsigns');
  const rows = (raw.data ?? []).map(toCallsignRow);
  // Alphabetical by normalized name for a stable editor table (list
  // order is not guaranteed by AppSync).
  rows.sort((a, b) => a.normalized.localeCompare(b.normalized));
  return rows;
}

export async function createCallsign(input: CallsignInput): Promise<CallsignRow> {
  const client = getDataClient();
  const createFn = client.models.Callsign.create as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await createFn({ ...input }, USER_POOL);
  throwOnErrors(raw.errors, 'createCallsign');
  if (!raw.data) throw new Error('createCallsign: empty response');
  return toCallsignRow(raw.data);
}

export async function updateCallsign(id: string, input: CallsignInput): Promise<CallsignRow> {
  const client = getDataClient();
  const updateFn = client.models.Callsign.update as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await updateFn({ id, ...input }, USER_POOL);
  throwOnErrors(raw.errors, 'updateCallsign');
  if (!raw.data) throw new Error('updateCallsign: empty response');
  return toCallsignRow(raw.data);
}

/** Approve an AI-suggested / pending callsign row (sets `approved=true`). */
export async function approveCallsign(id: string): Promise<CallsignRow> {
  const client = getDataClient();
  const updateFn = client.models.Callsign.update as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await updateFn({ id, approved: true }, USER_POOL);
  throwOnErrors(raw.errors, 'approveCallsign');
  if (!raw.data) throw new Error('approveCallsign: empty response');
  return toCallsignRow(raw.data);
}

export async function deleteCallsign(id: string): Promise<void> {
  const client = getDataClient();
  const deleteFn = client.models.Callsign.delete as unknown as (
    input: { id: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await deleteFn({ id }, USER_POOL);
  throwOnErrors(raw.errors, 'deleteCallsign');
}
