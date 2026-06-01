/**
 * A run of text classified as either a search-term match or not.
 */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

function escapeRegExp(s: string): string {
  // Escape every character that carries meaning in a RegExp so the
  // user's raw query is matched as a literal substring — prevents
  // regex injection / `SyntaxError` from a paste like `(foo` or `.*`.
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split `text` into ordered segments, flagging the runs that match
 * `q` (case-insensitive, literal substring). When `q` is empty or not
 * found, the whole string comes back as a single non-match segment so
 * callers can render uniformly.
 */
export function splitHighlight(text: string, q: string): HighlightSegment[] {
  const trimmed = q.trim();
  if (!trimmed) return [{ text, match: false }];

  const re = new RegExp(escapeRegExp(trimmed), 'gi');
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index;
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), match: false });
    }
    segments.push({ text: m[0], match: true });
    lastIndex = start + m[0].length;
  }
  if (lastIndex < text.length || segments.length === 0) {
    segments.push({ text: text.slice(lastIndex), match: false });
  }
  return segments;
}
