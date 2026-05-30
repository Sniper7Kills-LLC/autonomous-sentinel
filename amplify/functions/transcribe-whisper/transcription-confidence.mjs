/**
 * Overall whisper transcription-confidence aggregation (#581).
 *
 * whisper.cpp `-oj` emits per-token probabilities in the nested
 * `transcription[].tokens[]` array: each token carries a `p` in [0,1]
 * (the model's softmax probability for that token). We aggregate those
 * per-token probabilities into a single whole-recording 0–1 score.
 *
 * AGGREGATION CHOICE — **arithmetic mean of the per-token `p`** over the
 * SAME content-token filter `word-timestamps.mjs` uses (meta-tokens like
 * `[_BEG_]`, punctuation-only, and empty tokens excluded). Rationale:
 *   - The mean is the most legible single number for the moderator debug
 *     panel (#561) and the downstream low-confidence Amazon Transcribe
 *     escalation gate (#582) — "the model was ~0.74 sure on average".
 *   - A geometric mean of segment `avg_logprob` (the documented
 *     alternative) collapses fast toward 0 on a single low-prob token and
 *     is harder to threshold intuitively; the owner can revisit if the
 *     escalation gate wants a stricter signal.
 *   - Filtering meta/punctuation tokens keeps the score about *spoken
 *     content* — `[_BEG_]`/`[_TT_n]` markers carry no acoustic confidence
 *     about the words and would otherwise skew the mean.
 *
 * Robustness: older / alternate whisper.cpp output may omit `p`. This
 * function NEVER throws — malformed JSON, a missing `transcription`
 * array, or zero finite `p` values all resolve to `null` (caller then
 * omits `transcriptionConfidence` from the queue message).
 *
 * Authored as `.mjs` so the in-container handler imports it without a
 * build step (same pattern as `word-timestamps.mjs`). The `.test.ts`
 * sibling type-checks + exercises it under vitest.
 */

/**
 * Whether a whisper.cpp token represents spoken content (not a meta /
 * punctuation-only / empty token). Mirrors the filter in
 * `word-timestamps.mjs:extractWordTimestamps` so both derived artifacts
 * agree on what counts as a "word".
 *
 * @param {unknown} text
 * @returns {boolean}
 */
function isContentToken(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('[') || !/[A-Za-z0-9]/.test(trimmed)) return false;
  return true;
}

/**
 * Aggregate per-token probabilities into one 0–1 confidence score.
 *
 * @param {string} jsonString - raw whisper.cpp `-oj` JSON.
 * @returns {number | null} mean per-token `p` over content tokens, or
 *   `null` when no finite `p` is present (never throws).
 */
export function extractTranscriptionConfidence(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return null;
  }
  const segments = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
  let sum = 0;
  let count = 0;
  for (const seg of segments) {
    const tokens = Array.isArray(seg?.tokens) ? seg.tokens : [];
    for (const t of tokens) {
      if (!isContentToken(t?.text)) continue;
      const p = t?.p;
      // Only finite numbers in [0,1] count — guard against older output
      // omitting `p` (undefined) or an out-of-range value.
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) continue;
      sum += p;
      count += 1;
    }
  }
  if (count === 0) return null;
  return sum / count;
}
