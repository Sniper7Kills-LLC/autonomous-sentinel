/**
 * Per-backend transcript collection helpers (#593).
 *
 * A Recording now carries MULTIPLE transcripts side by side — one per
 * transcription backend (whisper-local, amazon-transcribe, …) — so the
 * Bedrock parse can reconcile across the independent ASR sources. These
 * helpers own:
 *
 *   1. `coerceTranscripts` — read the Recording's `transcripts` (a.json())
 *      back to a typed array, tolerating the AWSJSON-parsed array, a JSON
 *      string, or an absent value (legacy rows pre-#593).
 *   2. `upsertTranscript` — append/replace the entry for ONE backend
 *      WITHOUT touching the other backends' entries.
 *   3. `selectPrimary` — pick the "primary/active" transcript the
 *      top-level `Recording.transcript` / `transcriptionConfidence`
 *      mirror for back-compat with every existing reader.
 *
 * Primary-selection rule (documented on the model): highest
 * `transcriptionConfidence` wins; entries with no confidence sort last;
 * ties (including all-missing-confidence) break to the MOST-RECENT entry
 * by `ts`. This keeps a single-whisper recording behaving exactly as
 * before #593 — its one entry is trivially primary.
 */

export interface RecordingTranscript {
  /** Backend that produced this transcript (`whisper-local`, `amazon-transcribe`, …). */
  backend: string;
  /** The transcript text. */
  transcript: string;
  /** Overall transcription confidence in [0,1], or null when the backend reported none. */
  transcriptionConfidence?: number | null;
  /** S3 key of the per-word timestamps JSON sidecar (#92), when present. */
  wordTimestampsKey?: string | null;
  /** ISO timestamp this transcript was recorded onto the Recording. */
  ts: string;
}

/**
 * Coerce a Recording's `transcripts` (a.json()) to a typed array. AppSync
 * returns AWSJSON parsed (array) on read; a JSON string is tolerated for
 * older/seeded rows. Anything else (object, number, parse failure) → `[]`.
 * Each element is validated to carry a string `backend` + `transcript`;
 * malformed entries are dropped rather than poisoning the collection.
 */
export function coerceTranscripts(value: unknown): RecordingTranscript[] {
  let v: unknown = value;
  if (v == null) return [];
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: RecordingTranscript[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (typeof o.backend !== 'string' || o.backend === '') continue;
    if (typeof o.transcript !== 'string') continue;
    out.push({
      backend: o.backend,
      transcript: o.transcript,
      transcriptionConfidence:
        typeof o.transcriptionConfidence === 'number' ? o.transcriptionConfidence : null,
      ...(typeof o.wordTimestampsKey === 'string'
        ? { wordTimestampsKey: o.wordTimestampsKey }
        : {}),
      ts: typeof o.ts === 'string' ? o.ts : '',
    });
  }
  return out;
}

/**
 * Append the new entry, or REPLACE the existing entry for the same
 * backend (a re-transcribe on the same backend overwrites its own prior
 * pass), leaving every OTHER backend's entry intact. Returns a new array
 * (does not mutate `existing`).
 */
export function upsertTranscript(
  existing: RecordingTranscript[],
  entry: RecordingTranscript,
): RecordingTranscript[] {
  const next = existing.filter((t) => t.backend !== entry.backend);
  next.push(entry);
  return next;
}

/**
 * Pick the primary/active transcript: highest `transcriptionConfidence`,
 * with no-confidence entries last, breaking ties to the most-recent `ts`.
 * Returns `null` for an empty collection.
 */
export function selectPrimary(transcripts: RecordingTranscript[]): RecordingTranscript | null {
  if (transcripts.length === 0) return null;
  return [...transcripts].sort((a, b) => {
    const ca = typeof a.transcriptionConfidence === 'number' ? a.transcriptionConfidence : -1;
    const cb = typeof b.transcriptionConfidence === 'number' ? b.transcriptionConfidence : -1;
    if (cb !== ca) return cb - ca;
    // Tie → most recent first. Empty ts sorts last among ties.
    return (b.ts ?? '').localeCompare(a.ts ?? '');
  })[0]!;
}
