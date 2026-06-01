/**
 * Pure logic for the two LinguisticConfig editor surfaces (#110):
 * per-message-type confidence thresholds and per-message-type schema
 * definitions. Kept framework-free so the clamp / parse / defaulting
 * rules are unit-testable in isolation from React.
 *
 * Both surfaces persist to the existing `LinguisticConfig` model
 * (`amplify/data/models/linguistic-config.ts`) as a single keyed row:
 *   - key `"thresholds"` → value `{ [MessageType]: number }` (0..1)
 *   - key `"schemas"`    → value `{ [MessageType]: unknown }` (JSON object per type)
 * The read/upsert client helpers live in `lib/admin/linguistic.ts`.
 */
import { MESSAGE_TYPES, type MessageType } from '@/lib/messages/filters';

/** LinguisticConfig row keys this editor owns. */
export const THRESHOLDS_KEY = 'thresholds';
export const SCHEMAS_KEY = 'schemas';

/** Project-wide default confidence threshold (CLAUDE.md → 0.8 default). */
export const DEFAULT_THRESHOLD = 0.8;

export type ThresholdMap = Record<MessageType, number>;

/**
 * Clamp a single threshold into the valid [0, 1] range. Non-finite input
 * (NaN, ±Infinity, undefined) falls back to {@link DEFAULT_THRESHOLD} so a
 * half-typed numeric field never persists garbage.
 */
export function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Build a complete per-type threshold map, defaulting any missing or
 * invalid entry to {@link DEFAULT_THRESHOLD} and clamping the rest. The
 * stored `value` blob may be partial (only edited types) or stale (extra
 * keys); this normalizes it to exactly the current MessageType set.
 */
export function normalizeThresholds(raw: unknown): ThresholdMap {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as ThresholdMap;
  for (const type of MESSAGE_TYPES) {
    const v = source[type];
    out[type] = typeof v === 'number' ? clampThreshold(v) : DEFAULT_THRESHOLD;
  }
  return out;
}

export type SchemaParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Parse + validate the JSON a user typed for one message-type schema.
 * Empty / whitespace-only input is treated as "no schema" → an empty
 * object (a valid, no-constraint schema). A non-object JSON value
 * (array, string, number) is rejected: a schema definition must be a
 * JSON object keyed by field.
 */
export function parseSchemaJson(text: string): SchemaParseResult {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Schema must be a JSON object (e.g. { "field": ... }).' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export type SchemaMap = Record<MessageType, Record<string, unknown>>;

/**
 * Build a complete per-type schema map from the stored blob, defaulting
 * any missing / non-object entry to an empty object. Mirrors
 * {@link normalizeThresholds} for the schemas surface.
 */
export function normalizeSchemas(raw: unknown): SchemaMap {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as SchemaMap;
  for (const type of MESSAGE_TYPES) {
    const v = source[type];
    out[type] =
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }
  return out;
}

/** Pretty-print a schema object for the textarea editor (2-space indent). */
export function formatSchemaJson(value: Record<string, unknown>): string {
  if (Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
}
