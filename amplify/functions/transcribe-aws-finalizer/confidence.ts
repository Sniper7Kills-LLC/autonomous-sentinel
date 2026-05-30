import type { WordTimestamp } from '../_shared/timestamps';

/**
 * Recording-level confidence aggregation (#585, mirroring #581).
 *
 * Amazon Transcribe reports a per-item (per-word) confidence in
 * `[0, 1]`. `parseTranscribeResult` (#56) projects those onto the
 * canonical `WordTimestamp[]`, each carrying an optional
 * `confidence`. The Recording model stores a single 0–1
 * `transcriptionConfidence`; #581 settled on the ARITHMETIC MEAN of
 * the per-item confidences as the recording-level rollup, so every
 * backend reports the same statistic.
 *
 * Returns `null` when no word carries a usable confidence (e.g. a
 * future Transcribe schema drops the field, or every item is
 * punctuation). A `null` rollup means "unknown", NOT "zero" — the
 * downstream linguistic handler treats an absent
 * `transcriptionConfidence` as unset rather than a low-confidence
 * signal.
 */
export function meanWordConfidence(words: readonly WordTimestamp[]): number | null {
  let sum = 0;
  let count = 0;
  for (const w of words) {
    const c = w.confidence;
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1) {
      sum += c;
      count += 1;
    }
  }
  if (count === 0) return null;
  return sum / count;
}
