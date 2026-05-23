/**
 * Word-level timestamp normalisers (#61).
 *
 * Every transcribe backend can emit per-word offsets, but the
 * native shapes diverge. We normalise to a single
 * `WordTimestamp[]` per Transcript so the audio player code
 * (CLAUDE.md → Audio player features → "scrub-to-text sync —
 * word-level timestamps drive text highlight") is backend-
 * agnostic.
 *
 * After chunking (#59) the per-chunk timestamps are local to
 * each chunk; `offsetWords` shifts them onto the global
 * recording clock, and `stitchChunks` is the convenience for
 * multi-chunk results.
 *
 * Pure JS. The deferred backend handlers each call their
 * matching normaliser and persist the resulting
 * `Transcript.words` JSON column.
 */

export interface WordTimestamp {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

/* ----- OpenAI verbose_json (#55) ---------------------------------- */

/**
 * Shape of OpenAI Whisper API `verbose_json` `words[]` entry —
 * seconds as floats. Defined locally so this module does NOT
 * import from `transcribe-openai/client.ts` (the normaliser is
 * shared infra and shouldn't depend on a specific backend).
 */
interface OpenAIWord {
  word: string;
  start: number;
  end: number;
}

interface OpenAIVerboseLike {
  words?: OpenAIWord[];
}

/**
 * Normalise the OpenAI Whisper API `verbose_json` shape:
 * `{ words: [{ word, start, end }] }` where times are seconds.
 * Returns an empty array when no `words[]` is present (older
 * response shapes / non-verbose_json responses).
 */
export function normalizeOpenAIVerbose(
  payload: OpenAIVerboseLike | null | undefined,
): WordTimestamp[] {
  if (!payload || !Array.isArray(payload.words)) return [];
  return payload.words
    .filter(
      (w): w is OpenAIWord => isFiniteSecondsRange(w?.start, w?.end) && typeof w.word === 'string',
    )
    .map((w) => ({
      word: w.word,
      startMs: Math.round(w.start * 1000),
      endMs: Math.round(w.end * 1000),
    }));
}

/* ----- whisper.cpp -oj (#53/#54) ---------------------------------- */

interface WhisperCppToken {
  text: string;
  t0: number;
  t1: number;
  p?: number;
}

interface WhisperCppSegment {
  tokens?: WhisperCppToken[];
}

interface WhisperCppPayload {
  transcription?: WhisperCppSegment[];
}

/**
 * Normalise the whisper.cpp `-oj` shape:
 * `transcription[].tokens[].{ text, t0, t1, p }` where `t0`/`t1`
 * are CENTISECONDS (1/100s). Filters out the bracketed
 * meta-tokens whisper.cpp emits (`[_BEG_]`, `[_TT_n]`, etc.) so
 * only spoken words land in the array.
 */
export function normalizeWhisperCpp(
  payload: WhisperCppPayload | null | undefined,
): WordTimestamp[] {
  if (!payload || !Array.isArray(payload.transcription)) return [];
  const out: WordTimestamp[] = [];
  for (const seg of payload.transcription) {
    if (!Array.isArray(seg.tokens)) continue;
    for (const t of seg.tokens) {
      if (typeof t?.text !== 'string') continue;
      if (t.text.trim().startsWith('[')) continue; // meta-token
      if (!Number.isFinite(t.t0) || !Number.isFinite(t.t1)) continue;
      const entry: WordTimestamp = {
        word: t.text,
        startMs: Math.round(t.t0 * 10),
        endMs: Math.round(t.t1 * 10),
      };
      if (typeof t.p === 'number' && Number.isFinite(t.p)) entry.confidence = t.p;
      out.push(entry);
    }
  }
  return out;
}

/* ----- Amazon Transcribe (#56) ------------------------------------ */

interface TranscribeAlternative {
  content?: string;
  confidence?: string;
}

interface TranscribeItem {
  type?: string;
  start_time?: string;
  end_time?: string;
  alternatives?: TranscribeAlternative[];
}

interface AmazonTranscribePayload {
  results?: {
    items?: TranscribeItem[];
  };
}

/**
 * Normalise the Amazon Transcribe JSON output:
 * `results.items[].{ type, start_time, end_time, alternatives[0].content }`
 * where times are STRING seconds (Transcribe quirk). Punctuation
 * items (`type === 'punctuation'`) have no times and are skipped.
 * `alternatives[0].confidence` is also a string and maps to
 * `confidence: number`.
 */
export function normalizeAmazonTranscribe(
  payload: AmazonTranscribePayload | null | undefined,
): WordTimestamp[] {
  const items = payload?.results?.items;
  if (!Array.isArray(items)) return [];
  const out: WordTimestamp[] = [];
  for (const item of items) {
    if (item.type === 'punctuation') continue;
    const startStr = item.start_time;
    const endStr = item.end_time;
    if (typeof startStr !== 'string' || typeof endStr !== 'string') continue;
    const start = Number(startStr);
    const end = Number(endStr);
    if (!isFiniteSecondsRange(start, end)) continue;
    const alt = item.alternatives?.[0];
    if (!alt || typeof alt.content !== 'string') continue;
    const entry: WordTimestamp = {
      word: alt.content,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
    };
    if (typeof alt.confidence === 'string') {
      const c = Number(alt.confidence);
      if (Number.isFinite(c)) entry.confidence = c;
    }
    out.push(entry);
  }
  return out;
}

/* ----- chunk-offset stitching (#59) ------------------------------- */

/**
 * Shifts each word's `startMs`/`endMs` by `offsetMs`. Used by the
 * stitcher (#59) when concatenating per-chunk normalised words
 * into the global recording clock.
 *
 * Returns a NEW array; never mutates the input.
 */
export function offsetWords(words: WordTimestamp[], offsetMs: number): WordTimestamp[] {
  if (!Number.isFinite(offsetMs)) {
    throw new Error('offsetWords: offsetMs must be a finite number');
  }
  if (offsetMs === 0) return [...words];
  return words.map((w) => ({
    ...w,
    startMs: w.startMs + offsetMs,
    endMs: w.endMs + offsetMs,
  }));
}

export interface WordChunk {
  /** Per-chunk normalised words (timestamps local to the chunk). */
  words: WordTimestamp[];
  /** Chunk start position on the global recording clock, in ms. */
  startMs: number;
}

/**
 * Concatenates an ordered list of chunks into a single
 * `WordTimestamp[]` with timestamps shifted onto the global
 * recording clock.
 */
export function stitchChunks(chunks: WordChunk[]): WordTimestamp[] {
  const out: WordTimestamp[] = [];
  for (const chunk of chunks) {
    for (const w of offsetWords(chunk.words, chunk.startMs)) out.push(w);
  }
  return out;
}

/* ----- internals -------------------------------------------------- */

function isFiniteSecondsRange(start: unknown, end: unknown): boolean {
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < 0 || end < 0) return false;
  if (end < start) return false;
  return true;
}
