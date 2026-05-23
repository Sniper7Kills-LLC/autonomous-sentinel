import { createHash } from 'node:crypto';

/**
 * Amazon Transcribe custom-vocabulary helpers (#56).
 *
 * The (c) backend in CLAUDE.md → Pipeline components → Transcribe
 * Lambda. Transcribe accepts a per-language custom-vocabulary list
 * uploaded once + referenced by name on every job. Vocab name must
 * remain stable while the callsign dictionary is unchanged so jobs
 * don't pay the upload cost per recording; bumping the dictionary
 * must change the name so a fresh vocab is created + jobs route
 * to it without an in-place update race.
 *
 * Pure JS. The deferred backend handler computes the hash from
 * the callsign dictionary at cold start, calls Transcribe
 * `GetVocabulary` against the derived name, falls back to
 * `CreateVocabulary` when 404, then issues `StartTranscriptionJob`
 * with `Settings.VocabularyName` set.
 *
 * Vocab name format: `eam-callsigns-<12-char-hex-prefix>`.
 *   - `eam-callsigns-` is the project namespace.
 *   - 12 hex chars (48 bits) — collision space ≈ 2^48 ≈ 2.8e14,
 *     more than enough for a hand-curated dictionary that rolls
 *     over a handful of times per year.
 *   - Total length ≤ 27 chars; well within Transcribe's 200-char
 *     vocab name limit, leaves room for an `-en-US` suffix if we
 *     ever go multi-language.
 *
 * Normalisation rules (applied before hashing):
 *   1. Trim whitespace.
 *   2. Uppercase (Transcribe vocab entries are case-sensitive on
 *      the bias-toward-this-word side; uppercasing here matches
 *      the SKYKING / MAINSAIL convention from CLAUDE.md without
 *      surprising the caller).
 *   3. Drop empty / non-string entries.
 *   4. Deduplicate.
 *   5. Sort lexicographically — order-independent hash so
 *      reordering the dictionary doesn't burn a new vocab upload.
 */

export const VOCAB_NAME_PREFIX = 'eam-callsigns-';
export const VOCAB_HASH_LENGTH = 12;

export interface VocabHash {
  /** SHA-256 hex digest of the canonicalised callsign list. */
  full: string;
  /** First `VOCAB_HASH_LENGTH` chars of `full` — embedded in the vocab name. */
  short: string;
  /** Final vocab name passed to Transcribe: `eam-callsigns-<short>`. */
  vocabName: string;
  /** Canonicalised callsign list the hash was computed over. */
  canonicalised: string[];
}

/**
 * Canonicalises a raw callsign list (trim / uppercase / drop empty
 * / dedupe / sort). Exposed for tests + for the deferred
 * `CreateVocabulary` call which needs the same list to pass to
 * `Phrases`.
 */
export function canonicaliseCallsigns(callsigns: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const raw of callsigns) {
    if (typeof raw !== 'string') continue;
    const norm = raw.trim().toUpperCase();
    if (norm.length === 0) continue;
    seen.add(norm);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Deterministic SHA-256 hash of the canonicalised callsign list +
 * derived vocab name. Identical input arrays produce identical
 * hashes regardless of original order or whitespace / case.
 */
export function computeVocabHash(callsigns: readonly (string | null | undefined)[]): VocabHash {
  const canonicalised = canonicaliseCallsigns(callsigns);
  const full = createHash('sha256').update(canonicalised.join('\n'), 'utf8').digest('hex');
  const short = full.slice(0, VOCAB_HASH_LENGTH);
  return {
    full,
    short,
    vocabName: `${VOCAB_NAME_PREFIX}${short}`,
    canonicalised,
  };
}

/**
 * Returns true when the new callsign list produces a different
 * vocab hash than the cached one — i.e. the deferred scheduled
 * mini-job needs to issue `UpdateVocabulary` (or, more correctly,
 * `CreateVocabulary` against the new hash-derived name and switch
 * subsequent jobs to it). Comparing on `full` not `short` so a
 * truncation collision can't suppress an update.
 */
export function vocabChanged(prevHashFull: string | null | undefined, next: VocabHash): boolean {
  if (typeof prevHashFull !== 'string') return true;
  if (prevHashFull.length === 0) return true;
  return prevHashFull !== next.full;
}
