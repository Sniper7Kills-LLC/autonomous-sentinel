import { describe, expect, it } from 'vitest';
import { extractWordTimestamps } from './word-timestamps.mjs';

/**
 * whisper.cpp `-oj` shape (without `-ml 1`): natural-sentence segments,
 * each carrying a nested `tokens[]` with per-token `t0`/`t1` in
 * CENTISECONDS. This is the timing source we derive the word sidecar
 * from (#527).
 */
const WHISPER_JSON = JSON.stringify({
  transcription: [
    {
      text: ' Skyking, do not answer.',
      tokens: [
        { text: '[_BEG_]', t0: 0, t1: 0 }, // meta-token — dropped
        { text: ' Skyking', t0: 30, t1: 95 }, // 0.30s–0.95s
        { text: ',', t0: 95, t1: 100 }, // punctuation-only — dropped
        { text: ' do', t0: 100, t1: 130 },
        { text: ' not', t0: 130, t1: 160 },
        { text: ' answer', t0: 160, t1: 220 },
      ],
    },
  ],
});

describe('extractWordTimestamps (#527)', () => {
  it('derives {words:[{word,start,end}]} in seconds from nested tokens', () => {
    const out = extractWordTimestamps(WHISPER_JSON);
    expect(out.words).toEqual([
      { word: 'Skyking', start: 0.3, end: 0.95 },
      { word: 'do', start: 1.0, end: 1.3 },
      { word: 'not', start: 1.3, end: 1.6 },
      { word: 'answer', start: 1.6, end: 2.2 },
    ]);
  });

  it('drops meta-tokens ([_BEG_], [_TT_n]) and punctuation-only tokens', () => {
    const out = extractWordTimestamps(WHISPER_JSON);
    expect(out.words.map((w) => w.word)).not.toContain('[_BEG_]');
    expect(out.words.map((w) => w.word)).not.toContain(',');
  });

  it('skips tokens with non-finite or inverted offsets', () => {
    const json = JSON.stringify({
      transcription: [
        {
          tokens: [
            { text: ' ok', t0: NaN, t1: 50 },
            { text: ' bad', t0: 80, t1: 40 }, // end < start
            { text: ' good', t0: 10, t1: 20 },
          ],
        },
      ],
    });
    const out = extractWordTimestamps(json);
    expect(out.words).toEqual([{ word: 'good', start: 0.1, end: 0.2 }]);
  });

  it('returns {words:[]} for malformed JSON or missing transcription', () => {
    expect(extractWordTimestamps('not json')).toEqual({ words: [] });
    expect(extractWordTimestamps('{}')).toEqual({ words: [] });
    expect(extractWordTimestamps(JSON.stringify({ transcription: 'nope' }))).toEqual({ words: [] });
  });

  it('treats a segment with missing or null tokens[] (and no offsets) as empty (no throw)', () => {
    const json = JSON.stringify({
      transcription: [
        { text: 'a', tokens: null },
        { text: 'b' }, // no tokens key, no offsets
        { text: 'c', tokens: [{ text: ' word', t0: 10, t1: 20 }] },
      ],
    });
    expect(extractWordTimestamps(json)).toEqual({
      words: [{ word: 'word', start: 0.1, end: 0.2 }],
    });
  });

  it('falls back to one entry per segment from offsets when tokens[] is absent (#536)', () => {
    // Plain `-oj` (pre-#536) shape: per-segment text + offsets (ms), NO
    // tokens[]. The sidecar must still carry timing — at segment
    // granularity — rather than coming out empty.
    const json = JSON.stringify({
      transcription: [
        { text: ' Skyking do not answer', offsets: { from: 300, to: 2200 } },
        { text: ' Alpha Bravo', offsets: { from: 2200, to: 3100 } },
      ],
    });
    expect(extractWordTimestamps(json)).toEqual({
      words: [
        { word: 'Skyking do not answer', start: 0.3, end: 2.2 },
        { word: 'Alpha Bravo', start: 2.2, end: 3.1 },
      ],
    });
  });

  it('prefers per-token timing over the segment fallback when tokens[] is present (#536)', () => {
    // When the full JSON (`-ojf`) carries tokens, use them — do NOT also
    // emit the whole-segment fallback entry (would duplicate the words).
    const json = JSON.stringify({
      transcription: [
        {
          text: ' Skyking answer',
          offsets: { from: 0, to: 5000 },
          tokens: [
            { text: ' Skyking', t0: 30, t1: 95 },
            { text: ' answer', t0: 100, t1: 160 },
          ],
        },
      ],
    });
    expect(extractWordTimestamps(json)).toEqual({
      words: [
        { word: 'Skyking', start: 0.3, end: 0.95 },
        { word: 'answer', start: 1.0, end: 1.6 },
      ],
    });
  });

  it('uses the segment fallback when tokens[] holds only meta/punctuation (#536)', () => {
    const json = JSON.stringify({
      transcription: [
        {
          text: ' Skyking',
          offsets: { from: 100, to: 900 },
          tokens: [
            { text: '[_BEG_]', t0: 0, t1: 0 },
            { text: ',', t0: 10, t1: 20 },
          ],
        },
      ],
    });
    expect(extractWordTimestamps(json)).toEqual({
      words: [{ word: 'Skyking', start: 0.1, end: 0.9 }],
    });
  });
});
