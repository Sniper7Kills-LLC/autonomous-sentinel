/**
 * Regex rule tester support (#546).
 *
 * The Linguistic Logic engine runs each rule's `pattern` as a
 * case-insensitive JavaScript RegExp against the transcript. This
 * mirrors that exactly so an admin can paste sample transcript text,
 * see whether a rule matches, and see WHICH span(s) and named capture
 * groups it pulls — before activating the rule.
 *
 * Pure functions only; no DOM. `RegexTester` renders the segments as
 * highlighted spans.
 */

/** A contiguous slice of the sample text, flagged as a match or not. */
export type HighlightSegment = { text: string; match: boolean };

export type RegexTestResult =
  | { ok: false; error: string }
  | {
      ok: true;
      matchCount: number;
      segments: HighlightSegment[];
      /** Named capture groups from the first match (engine reads these). */
      groups: Record<string, string>;
    };

/**
 * Compile `pattern` the way the engine does — case-insensitive, global —
 * and split `sample` into highlight segments around every match. A bad
 * regex (SyntaxError) returns `{ ok: false }` with the message, the same
 * failure the engine catches per-rule.
 */
export function testPattern(pattern: string, sample: string): RegexTestResult {
  if (pattern.trim() === '') {
    return { ok: false, error: 'Pattern is empty.' };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'gi');
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid regular expression.' };
  }

  const segments: HighlightSegment[] = [];
  let matchCount = 0;
  let groups: Record<string, string> = {};
  let cursor = 0;

  for (const m of sample.matchAll(re)) {
    const idx = m.index ?? 0;
    const whole = m[0];
    // Zero-length matches would loop forever in matchAll-style manual
    // scans; matchAll guards this, but skip empty hits from highlight
    // output so we don't emit empty segments.
    if (whole.length === 0) continue;
    if (idx > cursor) segments.push({ text: sample.slice(cursor, idx), match: false });
    segments.push({ text: whole, match: true });
    cursor = idx + whole.length;
    if (matchCount === 0 && m.groups) {
      groups = Object.fromEntries(
        Object.entries(m.groups).filter(([, v]) => typeof v === 'string'),
      );
    }
    matchCount += 1;
  }
  if (cursor < sample.length) segments.push({ text: sample.slice(cursor), match: false });

  return { ok: true, matchCount, segments, groups };
}
