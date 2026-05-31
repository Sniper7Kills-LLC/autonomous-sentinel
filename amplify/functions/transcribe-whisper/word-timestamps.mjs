/**
 * Word-timestamp derivation for the Whisper container Lambda (#527/#536).
 *
 * whisper.cpp's nested `transcription[].tokens[]` array carries per-token
 * timing, written ONLY under `--output-json-full` (`-ojf`). Each token is
 * `{ text, offsets: { from, to }, timestamps, id, p, t_dtw }` where
 * `offsets.{from,to}` are MILLISECONDS — the SAME unit/field as the
 * per-segment `offsets`. There is NO `t0`/`t1` field (an earlier version
 * of this helper read `t0`/`t1`, which are always undefined, so EVERY
 * token was skipped and the per-segment fallback fired — the entire clip
 * collapsed into one "word" and the audio-player highlighted it all at
 * once; #536-followup). We now read `offsets.{from,to}` per token.
 *
 * Plain `-oj` writes per-segment `text` + `offsets` and NO `tokens[]`; the
 * argv passes `-ojf` (#536), and this helper FALLS BACK to one entry per
 * segment (from the segment's `offsets.{from,to}`) so the sidecar is never
 * empty when any timing exists — resilient if a backend omits `tokens[]`.
 *
 * Output shape is `{ words: [{ word, start, end }] }` with times in
 * SECONDS — the canonical shape consumed by
 * `web/lib/audio/sidecars.ts:parseWordTimestamps`. Emitting that
 * decouples the sidecar from whisper.cpp's raw JSON so a future backend
 * swap doesn't ripple into the web parser.
 *
 * Authored as `.mjs` so the in-container handler imports it without a
 * build step (same pattern as `run-whisper.mjs` / `opus-transcode.mjs`).
 * The `.test.ts` sibling type-checks + exercises it under vitest.
 */

/**
 * @param {string} jsonString - raw whisper.cpp `-oj`/`-ojf` JSON.
 * @returns {{ words: { word: string; start: number; end: number }[] }}
 */
export function extractWordTimestamps(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { words: [] };
  }
  const segments = Array.isArray(parsed?.transcription) ? parsed.transcription : [];
  const words = [];
  for (const seg of segments) {
    const tokens = Array.isArray(seg?.tokens) ? seg.tokens : [];
    let pushedFromTokens = false;
    for (const t of tokens) {
      if (typeof t?.text !== 'string') continue;
      const text = t.text.trim();
      // Drop whisper.cpp meta-tokens (`[_BEG_]`, `[_TT_n]`, …) and
      // punctuation-only / empty tokens — they carry no spoken word.
      if (!text || text.startsWith('[') || !/[A-Za-z0-9]/.test(text)) continue;
      // Per-token timing lives in `offsets.{from,to}` (MILLISECONDS) — NOT
      // a `t0`/`t1` field (which doesn't exist in `-ojf` output).
      const offsets = t.offsets;
      if (!offsets || typeof offsets !== 'object') continue;
      const from = offsets.from;
      const to = offsets.to;
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const start = from / 1000;
      const end = to / 1000;
      if (end < start) continue;
      words.push({ word: text, start, end });
      pushedFromTokens = true;
    }
    // Per-segment fallback (#536): the segment yielded no usable token —
    // either no `tokens[]` (plain `-oj` output / a backend without
    // per-token timing) or only meta/garbage tokens. Emit ONE entry for
    // the whole segment from `offsets.{from,to}` (ms). Scrub-to-text then
    // highlights at segment granularity instead of going dark.
    if (!pushedFromTokens) {
      const segWord = segmentWord(seg);
      if (segWord) words.push(segWord);
    }
  }
  return { words };
}

/**
 * Derive a single `{word,start,end}` (seconds) for a whole segment from
 * its `text` + `offsets.{from,to}` (whisper.cpp ms). Returns null when
 * the segment carries no text or no finite offsets.
 *
 * @param {any} seg
 * @returns {{ word: string; start: number; end: number } | null}
 */
function segmentWord(seg) {
  const text = typeof seg?.text === 'string' ? seg.text.trim() : '';
  if (!text || !/[A-Za-z0-9]/.test(text)) return null;
  const offsets = seg?.offsets;
  if (!offsets || typeof offsets !== 'object') return null;
  const from = offsets.from;
  const to = offsets.to;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  // whisper.cpp `offsets` (segment and token alike) are MILLISECONDS.
  const start = from / 1000;
  const end = to / 1000;
  if (end < start) return null;
  return { word: text, start, end };
}
