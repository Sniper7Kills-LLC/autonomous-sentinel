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

  const words = normalizeAmazonTranscribe(
    payload as Parameters<typeof normalizeAmazonTranscribe>[0],
  );

  return {
    text: transcriptText,
    language,
    languageConfidence,
    words,
  };
}
