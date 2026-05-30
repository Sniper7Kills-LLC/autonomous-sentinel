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
 *
 * Safety: a hand-typed pattern can be pathological (catastrophic
 * backtracking, e.g. `(a+)+b`) which would hang the admin's browser tab
 * on a long sample. JavaScript has no regex-execution timeout, so the
 * only client-side defenses are (a) bounding the input length the regex
 * runs against and (b) capping the number of matches we iterate. Both
 * are applied below; a truncated/capped run is flagged in the result so
 * the UI can tell the admin the test was limited. The engine itself
 * runs server-side against bounded transcripts, so this cap is a tester
 * convenience, not a change to match semantics.
 */

/** Max characters of sample the tester will run the regex against. */
export const MAX_SAMPLE_LENGTH = 20_000;

/** Max matches the tester will collect before stopping the scan. */
export const MAX_MATCHES = 1_000;

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
      /** Sample was longer than MAX_SAMPLE_LENGTH and was truncated. */
      truncated: boolean;
      /** Match count hit MAX_MATCHES and the scan stopped early. */
      capped: boolean;
    };

/**
 * Compile `pattern` the way the engine does — case-insensitive, global —
 * and split `sample` into highlight segments around every match. A bad
 * regex (SyntaxError) returns `{ ok: false }` with the message, the same
 * failure the engine catches per-rule.
 *
 * The scan is bounded: at most `MAX_SAMPLE_LENGTH` characters of input
 * and `MAX_MATCHES` matches, so a pathological pattern can't spin the
 * browser indefinitely. Note this bounds the number of *matches*, not
 * the cost of a single catastrophic-backtracking match — there is no
 * way to time-box one `RegExp` step in JS — but it caps the dominant
 * runaway case (a cheap pattern matching unboundedly many times) and
 * keeps the input the engine chews on small.
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

  const truncated = sample.length > MAX_SAMPLE_LENGTH;
  const text = truncated ? sample.slice(0, MAX_SAMPLE_LENGTH) : sample;

  const segments: HighlightSegment[] = [];
  let matchCount = 0;
  let capped = false;
  let groups: Record<string, string> = {};
  let cursor = 0;

  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const whole = m[0];
    // Zero-length matches would loop forever in matchAll-style manual
    // scans; matchAll guards this, but skip empty hits from highlight
    // output so we don't emit empty segments.
    if (whole.length === 0) continue;
    if (idx > cursor) segments.push({ text: text.slice(cursor, idx), match: false });
    segments.push({ text: whole, match: true });
    cursor = idx + whole.length;
    if (matchCount === 0 && m.groups) {
      groups = Object.fromEntries(
        Object.entries(m.groups).filter(([, v]) => typeof v === 'string'),
      );
    }
    matchCount += 1;
    // Iteration cap: stop collecting once we hit MAX_MATCHES so a cheap
    // pattern matching unboundedly many times can't lock the tab.
    if (matchCount >= MAX_MATCHES) {
      capped = true;
      break;
    }
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });

  return { ok: true, matchCount, segments, groups, truncated, capped };
}
