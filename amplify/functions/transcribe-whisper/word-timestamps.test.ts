import { describe, expect, it } from 'vitest';
import { extractWordTimestamps } from './word-timestamps.mjs';

/**
 * whisper.cpp `-ojf` shape: natural-sentence segments, each carrying a
 * nested `tokens[]` where per-token timing is `offsets.{from,to}` in
 * MILLISECONDS (the SAME field/unit as the per-segment `offsets`). There
 * is NO `t0`/`t1` field. This is the timing source the word sidecar is
 * derived from (#527 / #536-followup).
 */
const WHISPER_JSON = JSON.stringify({
  transcription: [
    {
      text: ' Skyking, do not answer.',
      offsets: { from: 0, to: 2200 },
      tokens: [
        // Real whisper.cpp `-ojf` token: text + offsets (ms) + timestamps
        // string + id + probability `p`. We read `offsets`.
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 1 }, // meta — dropped
        {
          text: ' Skyking',
          offsets: { from: 300, to: 950 }, // 0.30s–0.95s
          timestamps: { from: '00:00:00,300', to: '00:00:00,950' },
          id: 770,
          p: 0.96,
        },
        { text: ',', offsets: { from: 950, to: 1000 }, p: 0.9 }, // punctuation — dropped
        { text: ' do', offsets: { from: 1000, to: 1300 }, p: 0.9 },
        { text: ' not', offsets: { from: 1300, to: 1600 }, p: 0.9 },
        { text: ' answer', offsets: { from: 1600, to: 2200 }, p: 0.9 },
      ],
    },
  ],
});

describe('extractWordTimestamps (#527 / #536)', () => {
  it('derives {words:[{word,start,end}]} in seconds from per-token offsets (ms)', () => {
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
            { text: ' ok', offsets: { from: NaN, to: 500 } },
            { text: ' bad', offsets: { from: 800, to: 400 } }, // end < start
            { text: ' good', offsets: { from: 100, to: 200 } },
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
        { text: 'c', tokens: [{ text: ' word', offsets: { from: 100, to: 200 } }] },
      ],
    });
    expect(extractWordTimestamps(json)).toEqual({
      words: [{ word: 'word', start: 0.1, end: 0.2 }],
    });
  });

  it('falls back to one entry per segment from offsets when tokens[] is absent (#536)', () => {
    // Plain `-oj` shape: per-segment text + offsets (ms), NO tokens[]. The
    // sidecar must still carry timing — at segment granularity — rather
    // than coming out empty.
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
    // When the full JSON (`-ojf`) carries usable tokens, use them — do NOT
    // also emit the whole-segment fallback entry (would collapse the clip
    // into one highlighted "word", the bug this fixes).
    const json = JSON.stringify({
      transcription: [
        {
          text: ' Skyking answer',
          offsets: { from: 0, to: 5000 },
          tokens: [
            { text: ' Skyking', offsets: { from: 300, to: 950 } },
            { text: ' answer', offsets: { from: 1000, to: 1600 } },
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
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: ',', offsets: { from: 10, to: 20 } },
          ],
        },
      ],
    });
    expect(extractWordTimestamps(json)).toEqual({
      words: [{ word: 'Skyking', start: 0.1, end: 0.9 }],
    });
  });
});
