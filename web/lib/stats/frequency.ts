import type { DisplayMessage } from '@/lib/messages/types';

/**
 * Pure corpus-frequency aggregations for the reworked stats charts
 * (#499 character frequency, #500 codeword frequency).
 *
 * Both metrics are *occurrence tallies across a window of Messages*, NOT
 * per-message distributions — and neither reads the per-row
 * `characterCount` / `codewordCount` fields (those are being removed by
 * amplify #501). Everything is computed from `Message.body` so the charts
 * stay correct after that drop.
 *
 * Aggregation runs client-side over the most-recent-N window loaded by
 * `useStatsMessages` (matches the existing daily/histogram charts). True
 * full-corpus server-side aggregation is deferred — see #499 / #500
 * "server-side aggregation + cache" tasks.
 */

export type CharFrequencyBucket = {
  /** Single uppercase character: `A`–`Z` or `0`–`9`. */
  char: string;
  count: number;
};

export type CodewordFrequencyBucket = {
  /** Uppercased codeword token. */
  codeword: string;
  count: number;
};

/**
 * Tally how many times each `A`–`Z` / `0`–`9` character appears across the
 * decoded bodies of the supplied Messages.
 *
 * Rules:
 * - Case-insensitive: lowercase letters fold to uppercase before tallying.
 * - Only alphanumerics count. Whitespace and punctuation (group separators,
 *   stray markup) are ignored — EAM bodies are phonetic codeword strings, so
 *   separators carry no signal.
 * - `null` / empty bodies contribute nothing.
 *
 * Sort: descending by count, ties broken alphanumerically (`0`–`9` then
 * `A`–`Z` via natural char-code order) so the ranking is deterministic.
 */
export function charFrequency(messages: Pick<DisplayMessage, 'body'>[]): CharFrequencyBucket[] {
  const map = new Map<string, number>();
  for (const m of messages) {
    const body = m.body;
    if (!body) continue;
    const upper = body.toUpperCase();
    for (const ch of upper) {
      if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) {
        map.set(ch, (map.get(ch) ?? 0) + 1);
      }
    }
  }
  return [...map.entries()]
    .map(([char, count]) => ({ char, count }))
    .sort((a, b) => b.count - a.count || a.char.localeCompare(b.char));
}

/**
 * Split a single body into contiguous `[A-Z0-9]{3,}` codeword tokens,
 * uppercased. Groups shorter than 3 characters are dropped (a 2-char or
 * 1-char run is not a codeword). Returns `[]` for null / empty bodies.
 *
 * Tokenization is anchored on non-alphanumeric boundaries, so punctuation,
 * whitespace, and case all behave the same regardless of how the upstream
 * transcript spaced the groups.
 */
export function tokenizeCodewords(body: string | null | undefined): string[] {
  if (!body) return [];
  const matches = body.toUpperCase().match(/[A-Z0-9]{3,}/g);
  return matches ?? [];
}

/**
 * Tally how many times each distinct codeword token appears across the
 * bodies of the supplied Messages.
 *
 * Sort: descending by count, ties broken alphabetically so the ranking is
 * deterministic. Callers cap to a top-N for display.
 */
export function codewordFrequency(
  messages: Pick<DisplayMessage, 'body'>[],
): CodewordFrequencyBucket[] {
  const map = new Map<string, number>();
  for (const m of messages) {
    for (const token of tokenizeCodewords(m.body)) {
      map.set(token, (map.get(token) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([codeword, count]) => ({ codeword, count }))
    .sort((a, b) => b.count - a.count || a.codeword.localeCompare(b.codeword));
}
