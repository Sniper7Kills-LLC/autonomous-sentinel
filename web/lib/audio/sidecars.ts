/**
 * Sidecar JSON parsers for the audio player surfaces.
 *
 * Word-timestamps JSON drives `<TranscriptSync>` — the highlighted-word
 * playhead on the transcript pane (#92). Peaks JSON drives the
 * `<Waveform>` wavesurfer render (#89), avoiding a client-side decode
 * pass on every load.
 *
 * Both shapes are produced by the pre-process / transcribe pipeline
 * (#52 / #59) and stored alongside the canonical Opus. The parsers
 * accept the canonical shape + a couple of looser variants so the
 * UI degrades cleanly when the pipeline writes a slightly different
 * payload over time.
 */

export interface WordTimestamp {
  /** Word text — passed through unchanged. */
  word: string;
  /** Start time, seconds. */
  start: number;
  /** End time, seconds. */
  end: number;
}

export interface PeaksData {
  /** Downsampled peak values, normalised to [0, 1] or [-1, 1]. */
  peaks: number[];
  /** Optional per-channel split — when present, average for mono render. */
  channels?: number[][];
  /** Optional original sample-rate for label render. */
  sampleRate?: number;
  /** Optional bucket count override; falls back to peaks.length. */
  length?: number;
}

/**
 * Parse a word-timestamps JSON payload. Accepts:
 *   - `[{word, start, end}, ...]`
 *   - `{ words: [{word, start, end}, ...] }`
 *   - `{ segments: [{ words: [...] }, ...] }` (whisper-style nested)
 */
export function parseWordTimestamps(raw: unknown): WordTimestamp[] {
  if (Array.isArray(raw)) return raw.map(normalizeWord).filter(isValidWord);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.words)) {
      return (obj.words as unknown[]).map(normalizeWord).filter(isValidWord);
    }
    if (Array.isArray(obj.segments)) {
      const out: WordTimestamp[] = [];
      for (const seg of obj.segments as unknown[]) {
        if (seg && typeof seg === 'object') {
          const segObj = seg as Record<string, unknown>;
          if (Array.isArray(segObj.words)) {
            for (const w of segObj.words as unknown[]) {
              const n = normalizeWord(w);
              if (isValidWord(n)) out.push(n);
            }
          }
        }
      }
      return out;
    }
  }
  return [];
}

function normalizeWord(raw: unknown): WordTimestamp {
  if (!raw || typeof raw !== 'object') {
    return { word: '', start: 0, end: 0 };
  }
  const obj = raw as Record<string, unknown>;
  const word =
    typeof obj.word === 'string' ? obj.word : typeof obj.text === 'string' ? obj.text : '';
  const start = numberOrZero(obj.start ?? obj.startTime ?? obj.t0);
  const end = numberOrZero(obj.end ?? obj.endTime ?? obj.t1);
  return { word, start, end };
}

function isValidWord(w: WordTimestamp): boolean {
  return w.word.length > 0 && w.end >= w.start;
}

function numberOrZero(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Parse a waveform-peaks JSON payload. Accepts:
 *   - `{ peaks: [..], sampleRate, length }`
 *   - `{ data: [..], sampleRate, length }` (audiowaveform-style)
 *   - `[number, ...]` (bare array)
 *   - `{ channels: [[..], [..]] }` (per-channel split, averaged here)
 */
export function parsePeaks(raw: unknown): PeaksData | null {
  if (Array.isArray(raw)) {
    const peaks = raw.filter((n): n is number => typeof n === 'number');
    return peaks.length > 0 ? { peaks } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.channels)) {
    const channels = (obj.channels as unknown[]).filter(Array.isArray) as number[][];
    if (channels.length === 0) return null;
    const peaks = averageChannels(channels);
    return {
      peaks,
      channels,
      sampleRate: typeof obj.sampleRate === 'number' ? obj.sampleRate : undefined,
      length: typeof obj.length === 'number' ? obj.length : peaks.length,
    };
  }
  const rawPeaks = obj.peaks ?? obj.data;
  if (Array.isArray(rawPeaks)) {
    const peaks = rawPeaks.filter((n): n is number => typeof n === 'number');
    if (peaks.length === 0) return null;
    return {
      peaks,
      sampleRate: typeof obj.sampleRate === 'number' ? obj.sampleRate : undefined,
      length: typeof obj.length === 'number' ? obj.length : peaks.length,
    };
  }
  return null;
}

function averageChannels(channels: number[][]): number[] {
  const minLen = Math.min(...channels.map((c) => c.length));
  const out = new Array<number>(minLen);
  for (let i = 0; i < minLen; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * Active-word lookup — returns the index into `words` whose
 * `[start, end)` contains the playhead. -1 when no match (e.g.
 * pre-roll silence or gap between words). Linear scan; words
 * lists are short enough that an interval tree is overkill at v1.
 */
export function findActiveWord(words: WordTimestamp[], time: number): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (time >= w.start && time < w.end) return i;
  }
  return -1;
}
