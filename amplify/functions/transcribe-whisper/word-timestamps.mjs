/**
 * Word-timestamp derivation for the Whisper container Lambda (#527/#536).
 *
 * whisper.cpp's nested `transcription[].tokens[].{ text, t0, t1 }` array
 * (`t0`/`t1` in CENTISECONDS, 1/100 s) carries per-token timing — but it
 * is ONLY written under `--output-json-full` (`-ojf`). Plain `-oj` writes
 * per-segment `text` + `offsets.{from,to}` (MILLISECONDS) and NO
 * `tokens[]`. Before #536 the argv used `-oj`, so this helper found no
 * tokens and produced an empty sidecar — the audio-player scrub-to-text
 * break. `run-whisper.mjs` now passes `-ojf`; this helper prefers the
 * per-token array and FALLS BACK to one entry per segment (from the
 * segment's `offsets.{from,to}`) so the sidecar is never empty when any
 * timing exists — resilient even if a backend ever omits `tokens[]` again.
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
      if (!Number.isFinite(t.t0) || !Number.isFinite(t.t1)) continue;
      const start = t.t0 / 100;
      const end = t.t1 / 100;
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
  // whisper.cpp segment offsets are MILLISECONDS (token t0/t1 are cs).
  const start = from / 1000;
  const end = to / 1000;
  if (end < start) return null;
  return { word: text, start, end };
}
