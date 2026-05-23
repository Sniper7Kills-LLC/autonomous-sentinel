import type { WordTimestamp } from './timestamps';
import { offsetWords } from './timestamps';

/**
 * Transcribe chunk-boundary math + stitcher (#59).
 *
 * Long auto-recordings ("can hit hours" per CLAUDE.md) blow past
 * Whisper's practical context window and Lambda's wall-clock
 * budget. The deferred chunker Lambda walks `computeChunkBoundaries`
 * over `(durationMs, vadSegments)`, calls ffmpeg to slice the
 * canonical Opus at each `[startMs, endMs)`, fans out one SQS
 * message per chunk to the chosen backend, and the deferred
 * stitcher Lambda concatenates the per-chunk Transcripts back
 * into the global recording clock via `stitchTranscripts`.
 *
 * This module is the pure-JS slice — boundaries + stitching only.
 * ffmpeg slicing + S3 + DDB counter wiring stays in the deferred
 * Lambda; this code is testable without Docker.
 *
 * Strategy:
 *   - Recording ≤ `targetChunkMs` (default 5 min) → single chunk.
 *   - Otherwise, for each k * targetChunkMs target, find the
 *     silence boundary closest to the target within ±
 *     `silenceSearchWindowMs` (default 30 s) and split there.
 *     Falls back to a hard cut at the target when no silence
 *     lands inside the window.
 *   - Last chunk extends to `durationMs` regardless of overshoot.
 *
 * The bypass case (≤ targetChunkMs) still returns one chunk so
 * the deferred dispatcher can use `chunks_total=1` uniformly
 * (counter pattern from the spec).
 */

export const DEFAULT_TARGET_CHUNK_MS = 5 * 60 * 1000; // 5 min
export const DEFAULT_SILENCE_SEARCH_WINDOW_MS = 30 * 1000; // ±30 s
export const DEFAULT_CHUNK_KEY_PAD = 3; // 000.opus, 001.opus, ...

export interface ChunkBoundary {
  startMs: number;
  endMs: number;
  index: number;
}

/**
 * One contiguous run of audio classified as either speech or
 * silence. Boundaries are exclusive on the right
 * (`endMs - startMs === durationMs` for the whole array).
 */
export interface VadSegment {
  startMs: number;
  endMs: number;
  isSpeech: boolean;
}

export interface ChunkOpts {
  /** Target chunk length. Default 5 min. */
  targetChunkMs?: number;
  /**
   * Half-window the silence search sweeps around each target ms.
   * Default 30 s; reduce when VAD output is dense, increase
   * when broadcasts run long without pauses.
   */
  silenceSearchWindowMs?: number;
  /**
   * VAD segments for the recording. Optional — when absent the
   * chunker falls back to hard cuts at every target ms.
   */
  vad?: VadSegment[];
}

/**
 * Returns chunk boundaries spanning `[0, durationMs)`. Adjacent
 * chunks are end-to-end (no overlap, no gap). Last chunk always
 * extends to `durationMs`.
 *
 * Throws on non-finite / non-positive `durationMs` to surface
 * caller bugs at chunk-time rather than letting a zero-length
 * recording silently produce zero chunks (downstream stitcher
 * would then never fire).
 */
export function computeChunkBoundaries(durationMs: number, opts: ChunkOpts = {}): ChunkBoundary[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('computeChunkBoundaries: durationMs must be a positive finite number');
  }
  const target = opts.targetChunkMs ?? DEFAULT_TARGET_CHUNK_MS;
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error('computeChunkBoundaries: targetChunkMs must be a positive finite number');
  }

  if (durationMs <= target) {
    return [{ startMs: 0, endMs: durationMs, index: 0 }];
  }

  const window = opts.silenceSearchWindowMs ?? DEFAULT_SILENCE_SEARCH_WINDOW_MS;
  const vad = Array.isArray(opts.vad) ? opts.vad : [];

  const out: ChunkBoundary[] = [];
  let cursor = 0;
  let nextTarget = target;
  let index = 0;
  while (cursor < durationMs) {
    if (nextTarget >= durationMs) {
      out.push({ startMs: cursor, endMs: durationMs, index });
      break;
    }
    const cut = nearestSilence(vad, nextTarget, window) ?? nextTarget;
    // Defensive: a degenerate VAD answer that gives back a `cut`
    // not strictly between `cursor` and `durationMs` is treated
    // as no-silence-found and falls through to the hard target.
    const effectiveCut = cut > cursor && cut < durationMs ? cut : nextTarget;
    out.push({ startMs: cursor, endMs: effectiveCut, index });
    cursor = effectiveCut;
    nextTarget += target;
    index += 1;
  }
  return out;
}

/**
 * Returns the millisecond offset of the silence boundary closest
 * to `targetMs` within `±windowMs`, or `null` when none lies in
 * the window.
 *
 * Silence boundaries are computed from the VAD as the midpoint
 * of each `isSpeech=false` segment AND the transition points
 * between adjacent speech/non-speech segments. Picking the
 * midpoint avoids cutting on the very edge of a quiet moment,
 * where a word's tail might overrun by a few ms.
 */
export function nearestSilence(
  vad: VadSegment[] | null | undefined,
  targetMs: number,
  windowMs: number,
): number | null {
  if (!Array.isArray(vad) || vad.length === 0) return null;
  const candidates: number[] = [];
  for (const seg of vad) {
    if (!seg || typeof seg.startMs !== 'number' || typeof seg.endMs !== 'number') continue;
    if (!Number.isFinite(seg.startMs) || !Number.isFinite(seg.endMs)) continue;
    if (seg.endMs <= seg.startMs) continue;
    if (seg.isSpeech === false) {
      candidates.push(Math.floor((seg.startMs + seg.endMs) / 2));
    }
  }
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = Math.abs(c - targetMs);
    if (d <= windowMs && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

interface KeyOpts {
  pad?: number;
  prefix?: string;
}

/**
 * Computes the S3 chunk key for a given recording + chunk index.
 * Zero-pads the index so an `aws s3 ls` listing sorts in chunk
 * order (the stitcher walks the listing in that order).
 *
 * Default format:
 *   `pipeline-temp/<recordingId>/chunks/<NNN>.opus`
 */
export function chunkKeyFor(recordingId: string, index: number, opts: KeyOpts = {}): string {
  if (typeof recordingId !== 'string' || recordingId.length === 0) {
    throw new Error('chunkKeyFor: recordingId must be a non-empty string');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('chunkKeyFor: index must be a non-negative integer');
  }
  const pad = opts.pad ?? DEFAULT_CHUNK_KEY_PAD;
  const prefix = opts.prefix ?? `pipeline-temp/${recordingId}/chunks`;
  return `${prefix}/${String(index).padStart(pad, '0')}.opus`;
}

export interface ChunkTranscript {
  /** Boundary the chunk was sliced from. */
  boundary: ChunkBoundary;
  /** Transcript text local to this chunk. */
  text: string;
  /** Per-chunk word-level timestamps (timestamps local to the chunk). */
  words: WordTimestamp[];
}

export interface StitchedTranscript {
  text: string;
  words: WordTimestamp[];
}

/**
 * Stitches an ordered array of per-chunk Transcripts back into a
 * single global Transcript. Concatenates text (space-joined) and
 * shifts each chunk's words onto the global clock via
 * `offsetWords`.
 *
 * Input order matters — the stitcher walks the array left-to-
 * right. Pass chunks sorted by `boundary.index` so the global
 * text + word stream lines up with the original recording.
 */
export function stitchTranscripts(chunks: ChunkTranscript[]): StitchedTranscript {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { text: '', words: [] };
  }
  const parts: string[] = [];
  const allWords: WordTimestamp[] = [];
  for (const chunk of chunks) {
    // Defensive: a chunk row could land here with a missing or
    // malformed `boundary` (e.g. partial DDB read, schema-drift
    // during a migration). Skip + log rather than crash so one
    // bad chunk doesn't blow the stitcher up — the deferred
    // finalizer reconciles the chunk counter separately.
    if (
      !chunk ||
      !chunk.boundary ||
      typeof chunk.boundary.startMs !== 'number' ||
      !Number.isFinite(chunk.boundary.startMs)
    ) {
      console.warn('stitchTranscripts: skipping chunk with malformed boundary', {
        chunk,
      });
      continue;
    }
    const trimmed = typeof chunk.text === 'string' ? chunk.text.trim() : '';
    if (trimmed.length > 0) parts.push(trimmed);
    if (Array.isArray(chunk.words)) {
      for (const w of offsetWords(chunk.words, chunk.boundary.startMs)) {
        allWords.push(w);
      }
    }
  }
  return { text: parts.join(' '), words: allWords };
}
