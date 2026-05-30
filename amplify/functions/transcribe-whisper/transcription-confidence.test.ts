import { describe, expect, it } from 'vitest';
import { extractTranscriptionConfidence } from './transcription-confidence.mjs';

/**
 * whisper.cpp `-oj` token shape with per-token probability `p` (#581).
 * The aggregation is the arithmetic mean of `p` over content tokens —
 * meta-tokens (`[_BEG_]`), punctuation-only, and empty tokens are
 * excluded so the score reflects spoken-word confidence only.
 */
describe('extractTranscriptionConfidence (#581)', () => {
  it('returns the mean of per-token p over content tokens', () => {
    const json = JSON.stringify({
      transcription: [
        {
          text: ' Skyking, do not answer.',
          tokens: [
            { text: '[_BEG_]', t0: 0, t1: 0, p: 0.01 }, // meta — excluded
            { text: ' Skyking', t0: 30, t1: 95, p: 0.9 },
            { text: ',', t0: 95, t1: 100, p: 0.1 }, // punctuation — excluded
            { text: ' do', t0: 100, t1: 130, p: 0.8 },
            { text: ' not', t0: 130, t1: 160, p: 0.7 },
            { text: ' answer', t0: 160, t1: 220, p: 0.6 },
          ],
        },
      ],
    });
    // mean of [0.9, 0.8, 0.7, 0.6] = 0.75 (meta + punctuation dropped)
    expect(extractTranscriptionConfidence(json)).toBeCloseTo(0.75, 10);
  });

  it('averages across multiple segments', () => {
    const json = JSON.stringify({
      transcription: [
        { tokens: [{ text: ' alpha', t0: 0, t1: 10, p: 1.0 }] },
        { tokens: [{ text: ' bravo', t0: 10, t1: 20, p: 0.5 }] },
      ],
    });
    expect(extractTranscriptionConfidence(json)).toBeCloseTo(0.75, 10);
  });

  it('returns null when no token carries a finite p (older output)', () => {
    const json = JSON.stringify({
      transcription: [
        {
          text: ' Skyking do not answer',
          tokens: [
            { text: ' Skyking', t0: 30, t1: 95 },
            { text: ' do', t0: 100, t1: 130 },
          ],
        },
      ],
    });
    expect(extractTranscriptionConfidence(json)).toBeNull();
  });

  it('ignores non-finite / out-of-range p values', () => {
    const json = JSON.stringify({
      transcription: [
        {
          tokens: [
            { text: ' a', t0: 0, t1: 10, p: Number.NaN },
            { text: ' b', t0: 10, t1: 20, p: 1.5 }, // out of [0,1]
            { text: ' c', t0: 20, t1: 30, p: -0.2 }, // out of [0,1]
            { text: ' d', t0: 30, t1: 40, p: 0.4 },
          ],
        },
      ],
    });
    expect(extractTranscriptionConfidence(json)).toBeCloseTo(0.4, 10);
  });

  it('returns null for malformed JSON or missing transcription (no throw)', () => {
    expect(extractTranscriptionConfidence('not json')).toBeNull();
    expect(extractTranscriptionConfidence('{}')).toBeNull();
    expect(extractTranscriptionConfidence(JSON.stringify({ transcription: 'nope' }))).toBeNull();
  });

  it('treats a segment with missing or null tokens[] as empty (no throw)', () => {
    const json = JSON.stringify({
      transcription: [
        { text: 'a', tokens: null },
        { text: 'b' },
        { text: 'c', tokens: [{ text: ' word', t0: 10, t1: 20, p: 0.9 }] },
      ],
    });
    expect(extractTranscriptionConfidence(json)).toBeCloseTo(0.9, 10);
  });
});
