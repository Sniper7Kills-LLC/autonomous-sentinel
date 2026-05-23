import { normalizeAmazonTranscribe, type WordTimestamp } from '../_shared/timestamps';

/**
 * Amazon Transcribe job-output parser (#56).
 *
 * Amazon Transcribe writes the job result as JSON into the bucket
 * configured by `OutputBucketName` + `OutputKey`. The deferred
 * EventBridge finalizer Lambda downloads that JSON and calls
 * `parseTranscribeResult(json)` to project it onto the canonical
 * Transcript shape every other backend produces — so the
 * Linguistic Logic stage (#62) doesn't branch on backend.
 *
 * Reuses `normalizeAmazonTranscribe` from `_shared/timestamps.ts`
 * (#61) for the word-level array, then layers the top-level
 * transcript text + language identification on top.
 */

export interface TranscribeResult {
  /** Stitched transcript text from `results.transcripts[0].transcript`. */
  text: string;
  /** Detected language code as Transcribe reports it (e.g. `'en-US'`). */
  language: string | null;
  /** Backend-reported language identification confidence in [0, 1]. */
  languageConfidence: number | null;
  /** Canonical word-level timestamps via the shared normaliser. */
  words: WordTimestamp[];
}

/**
 * Loose typing of the Transcribe output JSON. Field names match
 * the AWS docs as of 2026-05; downstream behaviour is defensive
 * against missing fields so a future schema addition doesn't
 * break the pipeline.
 */
export interface TranscribeOutputJson {
  jobName?: string;
  status?: string;
  results?: {
    transcripts?: Array<{ transcript?: string }>;
    items?: unknown[];
    language_code?: string;
    language_identification?: Array<{ code?: string; score?: string | number }>;
  };
}

/**
 * Projects a Transcribe job-output JSON object onto the canonical
 * `TranscribeResult` shape. Throws on malformed input rather than
 * returning partial data — the deferred finalizer routes a throw
 * to the transcribe DLQ from #67 so the bad row gets human eyes.
 */
export function parseTranscribeResult(
  payload: TranscribeOutputJson | null | undefined,
): TranscribeResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('parseTranscribeResult: payload is not an object');
  }
  const results = payload.results;
  if (!results || typeof results !== 'object') {
    throw new Error('parseTranscribeResult: payload.results is missing');
  }

  const transcripts = results.transcripts;
  if (!Array.isArray(transcripts) || transcripts.length === 0) {
    throw new Error('parseTranscribeResult: payload.results.transcripts is missing or empty');
  }
  const transcriptText = transcripts[0]?.transcript;
  if (typeof transcriptText !== 'string') {
    throw new Error('parseTranscribeResult: results.transcripts[0].transcript is not a string');
  }
  if (transcriptText.trim() === '') {
    // An empty transcript means the recording transcribed to
    // silence — per CLAUDE.md → Pipeline components ("failed
    // transcription → recording stored with
    // `transcription_failed=true`, no Message") that is a
    // failed-transcription outcome, not a valid empty result.
    // Throwing routes the row to the transcribe DLQ from #67
    // for the deferred finalizer's failed-transcription path
    // rather than letting it pass into Linguistic Logic where
    // no rule will match.
    throw new Error('parseTranscribeResult: transcript text is empty (transcription_failed)');
  }

  const language = typeof results.language_code === 'string' ? results.language_code : null;

  let languageConfidence: number | null = null;
  if (
    Array.isArray(results.language_identification) &&
    results.language_identification.length > 0
  ) {
    const top = results.language_identification[0];
    const raw = top?.score;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      languageConfidence = raw;
    } else if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) languageConfidence = parsed;
    }
  }

  // Pass only the `items` slice the normaliser cares about so
  // the call site doesn't lean on a structural-cast between the
  // wider `TranscribeOutputJson` and the narrower
  // `AmazonTranscribePayload`. `items` may legitimately be
  // `undefined` here — normaliser returns `[]` in that case.
  const words = normalizeAmazonTranscribe({
    results: { items: Array.isArray(results.items) ? results.items : undefined },
  });

  return {
    text: transcriptText,
    language,
    languageConfidence,
    words,
  };
}
