/**
 * Word-timestamp derivation for the Whisper container Lambda (#527).
 *
 * whisper.cpp `-oj` emits per-token timing in the nested
 * `transcription[].tokens[].{ text, t0, t1 }` array, where `t0`/`t1`
 * are CENTISECONDS (1/100 s) — present whether or not `--max-len 1`
 * (`-ml 1`) is set. We dropped `-ml 1` so the segment text stays a
 * natural sentence (the transcript fed to linguistics); this helper
 * reconstructs the per-word timing the audio player's scrub-to-text
 * sync (#92) needs.
 *
 * Output shape is `{ words: [{ word, start, end }] }` with times in
 * SECONDS — the canonical shape consumed by
 * `web/lib/audio/sidecars.ts:parseWordTimestamps`. Emitting that
 * decouples the sidecar from whisper.cpp's raw JSON so a future
 * backend swap doesn't ripple into the web parser.
 *
 * Authored as `.mjs` so the in-container handler imports it without a
 * build step (same pattern as `run-whisper.mjs` / `opus-transcode.mjs`).
 * The `.test.ts` sibling type-checks + exercises it under vitest.
 */

/**
 * @param {string} jsonString - raw whisper.cpp `-oj` JSON.
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
    }
  }
  return { words };
}
