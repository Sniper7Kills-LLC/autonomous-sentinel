/**
 * Broadcast dedup primitives (#454).
 *
 * Multiple SDRs capture the same broadcast → those captures must link to
 * ONE Message (the domain model: 1 Message → 0..N Recordings), and SQS
 * redrives of one capture must not create duplicate Messages.
 *
 * Match = same `type` + broadcast time within a window + matching
 * content:
 *   - ALLSTATIONS / SKYKING: the decoded payload is canonical, so two
 *     captures of the same broadcast decode to the same string — match
 *     on **exact** normalized equality.
 *   - every other type: cross-SDR transcripts vary (whisper noise), so
 *     match on **token-set similarity ≥ threshold**.
 *
 * Pure functions only; the handler does the DDB query + link/create.
 */

/** Types whose normalized body is a decoded payload — exact-match. */
export const EXACT_MATCH_TYPES = new Set(['ALLSTATIONS', 'SKYKING']);

/** Default ± window (ms) around the broadcast time. Admin-tunable later. */
export const DEFAULT_DEDUP_WINDOW_MS = 120_000;
/** Default token-set similarity threshold for non-decoding types. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

import { createHash } from 'node:crypto';

/**
 * Deterministic Message id for `(type, canonical content, time bucket)`.
 * Doubles as the create-race guard: two captures with identical
 * canonical content in the same time bucket compute the same id, so the
 * second `Message.create` collides (attribute_exists) and links to the
 * first instead of duplicating. Non-identical (fuzzy) captures get
 * different ids and are deduped via the query + similarity path.
 */
export function deterministicMessageId(
  type: string,
  canonicalBody: string,
  broadcastIso: string,
  bucketMs: number = DEFAULT_DEDUP_WINDOW_MS,
): string {
  const bucket = Math.floor(new Date(broadcastIso).getTime() / bucketMs);
  const key = `${type}|${canonicalBody.toLowerCase().replace(/\s+/g, ' ').trim()}|${bucket}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Lowercase alphanumeric token set of a body, for fuzzy comparison. */
function tokenSet(body: string): Set<string> {
  return new Set(
    body
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/** Jaccard similarity of two bodies' token sets, in [0, 1]. */
export function tokenSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Normalize a body for exact comparison (case + whitespace insensitive). */
function canon(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether two parsed bodies of the same `type` represent the same
 * broadcast content. Exact for decoded types, similarity otherwise.
 */
export function contentMatches(
  type: string,
  a: string,
  b: string,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): boolean {
  if (EXACT_MATCH_TYPES.has(type)) {
    return canon(a) === canon(b) && canon(a).length > 0;
  }
  return tokenSimilarity(a, b) >= threshold;
}

/** ISO `[start, end]` window around a broadcast time for the GSI query. */
export function dedupWindow(
  broadcastIso: string,
  halfWindowMs: number = DEFAULT_DEDUP_WINDOW_MS,
): { start: string; end: string } {
  const t = new Date(broadcastIso).getTime();
  return {
    start: new Date(t - halfWindowMs).toISOString(),
    end: new Date(t + halfWindowMs).toISOString(),
  };
}
