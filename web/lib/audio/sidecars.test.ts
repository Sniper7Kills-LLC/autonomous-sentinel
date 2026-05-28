import { describe, it, expect } from 'vitest';
import { parseWordTimestamps, parsePeaks, findActiveWord } from './sidecars';

describe('parseWordTimestamps', () => {
  it('accepts a flat array of {word,start,end}', () => {
    expect(
      parseWordTimestamps([
        { word: 'SKYKING', start: 0, end: 0.6 },
        { word: 'PT3', start: 0.7, end: 1.0 },
      ]),
    ).toEqual([
      { word: 'SKYKING', start: 0, end: 0.6 },
      { word: 'PT3', start: 0.7, end: 1.0 },
    ]);
  });

  it('accepts a `words` wrapper', () => {
    expect(
      parseWordTimestamps({
        words: [{ word: 'one', start: 0, end: 0.2 }],
      }),
    ).toEqual([{ word: 'one', start: 0, end: 0.2 }]);
  });

  it('flattens whisper-style segmented payload', () => {
    expect(
      parseWordTimestamps({
        segments: [
          { words: [{ word: 'A', start: 0, end: 0.1 }] },
          { words: [{ word: 'B', start: 0.2, end: 0.3 }] },
        ],
      }),
    ).toEqual([
      { word: 'A', start: 0, end: 0.1 },
      { word: 'B', start: 0.2, end: 0.3 },
    ]);
  });

  it('coerces string timestamps + alternate keys (text/t0/t1)', () => {
    expect(parseWordTimestamps([{ text: 'hello', t0: '0.1', t1: '0.4' }])).toEqual([
      { word: 'hello', start: 0.1, end: 0.4 },
    ]);
  });

  it('drops invalid rows (empty word or end < start)', () => {
    expect(
      parseWordTimestamps([
        { word: '', start: 0, end: 1 },
        { word: 'ok', start: 1, end: 2 },
        { word: 'bad', start: 5, end: 4 },
      ]),
    ).toEqual([{ word: 'ok', start: 1, end: 2 }]);
  });

  it('returns empty array on garbage input', () => {
    expect(parseWordTimestamps(null)).toEqual([]);
    expect(parseWordTimestamps('nope')).toEqual([]);
    expect(parseWordTimestamps({})).toEqual([]);
  });
});

describe('parsePeaks', () => {
  it('accepts canonical {peaks} shape', () => {
    const out = parsePeaks({ peaks: [0, 0.5, 1, 0.5, 0], sampleRate: 16000 });
    expect(out?.peaks).toEqual([0, 0.5, 1, 0.5, 0]);
    expect(out?.sampleRate).toBe(16000);
  });

  it('accepts audiowaveform {data} shape', () => {
    expect(parsePeaks({ data: [0.1, 0.2, 0.3] })?.peaks).toEqual([0.1, 0.2, 0.3]);
  });

  it('averages per-channel arrays', () => {
    expect(
      parsePeaks({
        channels: [
          [0, 1],
          [1, 0],
        ],
      })?.peaks,
    ).toEqual([0.5, 0.5]);
  });

  it('accepts a bare array', () => {
    expect(parsePeaks([0, 0.5, 1])?.peaks).toEqual([0, 0.5, 1]);
  });

  it('returns null on garbage', () => {
    expect(parsePeaks(null)).toBeNull();
    expect(parsePeaks({})).toBeNull();
  });
});

describe('findActiveWord', () => {
  const words = [
    { word: 'one', start: 0, end: 0.5 },
    { word: 'two', start: 0.5, end: 1.0 },
    { word: 'three', start: 2.0, end: 2.5 },
  ];

  it('returns the index containing the playhead', () => {
    expect(findActiveWord(words, 0.3)).toBe(0);
    expect(findActiveWord(words, 0.5)).toBe(1);
    expect(findActiveWord(words, 2.25)).toBe(2);
  });

  it('returns -1 in gaps', () => {
    expect(findActiveWord(words, 1.5)).toBe(-1);
  });

  it('returns -1 for pre-start playhead', () => {
    expect(findActiveWord(words, -1)).toBe(-1);
  });
});
