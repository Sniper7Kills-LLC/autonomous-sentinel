/**
 * OpenAI hosted Whisper API client (#55).
 *
 * Pure-JS wrapper around the `POST /v1/audio/transcriptions`
 * endpoint. The deferred Lambda handler downloads the canonical
 * Opus from S3, calls `transcribeWithOpenAI`, and persists the
 * result onto the Recording's Transcript shape (same as the
 * self-hosted Whisper container backend so downstream stages
 * don't branch on backend).
 *
 * Per CLAUDE.md → Pipeline components → Transcribe Lambda (b),
 * this backend is opt-in via the selector (#58) — never the
 * default — because it's metered ($0.006/min as of 2026-05).
 *
 * Retry policy: exponential backoff on 429 (rate limit) and 5xx
 * (server error), `maxRetries` attempts in total (default 3),
 * 250ms base delay with 2x growth + jitter. Non-retryable 4xx
 * codes (400 / 401 / 403 / 404 / 413 / etc.) throw a typed
 * `OpenAIWhisperError` immediately so the deferred Lambda
 * surfaces them to the DLQ without burning the retry budget.
 *
 * Test seams: `opts.fetch` swaps the global fetch, `opts.sleep`
 * skips real backoff delays under vitest.
 *
 * Required env (consumed by the deferred handler, NOT this
 * helper — caller passes `apiKey` in directly):
 *   - `OPENAI_API_KEY` — pulled from Secrets Manager at Lambda
 *     init time.
 *   - `OPENAI_WHISPER_MODEL` — default `whisper-1`; override
 *     when OpenAI ships a newer model and we want to swap
 *     without a code change.
 *   - `OPENAI_WHISPER_BASE_URL` — default `https://api.openai.com`;
 *     override for staging / dev proxies.
 */

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
export const DEFAULT_OPENAI_WHISPER_MODEL = 'whisper-1';
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BACKOFF_BASE_MS = 250;

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** verbose_json response shape from the OpenAI Whisper API. */
export interface WhisperVerboseResponse {
  text: string;
  language: string;
  duration: number;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
}

export interface TranscribeOpts {
  apiKey: string;
  model?: string;
  language?: string;
  /** S3 object key or `recordingId.opus`; surfaces in OpenAI logs. */
  fileName?: string;
  /** Audio MIME type. Canonical pipeline produces `audio/ogg` (Opus). */
  mimeType?: string;
  baseUrl?: string;
  maxRetries?: number;
  backoffBaseMs?: number;
  /** Test seam — defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test seam — defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — defaults to Math.random for jitter. */
  random?: () => number;
}

export class OpenAIWhisperError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: string;
  constructor(status: number, retryable: boolean, body: string, message: string) {
    super(message);
    this.name = 'OpenAIWhisperError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoff(attempt: number, baseMs: number, random: () => number): number {
  // Exponential 2^attempt + uniform [0, baseMs) jitter so retries
  // from parallel Lambdas don't synchronise on the same OpenAI
  // throttle bucket.
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = random() * baseMs;
  return Math.floor(exp + jitter);
}

function isVerboseResponse(value: unknown): value is WhisperVerboseResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== 'string') return false;
  if (typeof v.language !== 'string') return false;
  if (typeof v.duration !== 'number') return false;
  return true;
}

/**
 * Transcribes `audioBytes` via the OpenAI Whisper API. Returns
 * the parsed verbose_json shape (text + language + duration +
 * word-level timestamps for #61 + segments).
 *
 * Throws `OpenAIWhisperError` on:
 *   - Non-retryable HTTP status after exhausting retries.
 *   - Malformed JSON / missing required verbose_json fields.
 *
 * Each call performs at most `maxRetries` retries on 429 / 5xx
 * (4 total attempts on default). Network errors thrown by
 * `fetch` are treated as retryable.
 */
export async function transcribeWithOpenAI(
  audioBytes: Uint8Array,
  opts: TranscribeOpts,
): Promise<WhisperVerboseResponse> {
  if (!opts.apiKey) {
    throw new Error('transcribeWithOpenAI: apiKey is required');
  }
  if (!audioBytes || audioBytes.byteLength === 0) {
    throw new Error('transcribeWithOpenAI: audioBytes must be non-empty');
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const baseUrl = opts.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const model = opts.model ?? DEFAULT_OPENAI_WHISPER_MODEL;
  const language = opts.language ?? 'en';
  const fileName = opts.fileName ?? 'audio.opus';
  const mimeType = opts.mimeType ?? 'audio/ogg';
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  const url = `${baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;

  let lastErr: OpenAIWhisperError | Error | null = null;
  const totalAttempts = maxRetries + 1;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    // Rebuild FormData per attempt — a consumed Blob stream is
    // not replayable on some runtimes.
    const form = new FormData();
    form.set('file', new Blob([audioBytes as unknown as BlobPart], { type: mimeType }), fileName);
    form.set('model', model);
    form.set('language', language);
    form.set('response_format', 'verbose_json');
    form.set('timestamp_granularities[]', 'word');

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn('transcribeWithOpenAI: network error', {
        attempt,
        error: lastErr.message,
      });
      if (attempt + 1 < totalAttempts) {
        await sleep(computeBackoff(attempt, backoffBaseMs, random));
        continue;
      }
      throw new OpenAIWhisperError(
        0,
        true,
        '',
        `OpenAI Whisper network error after ${attempt + 1} attempts: ${lastErr.message}`,
      );
    }

    if (res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch (err) {
        throw new OpenAIWhisperError(
          res.status,
          false,
          '',
          `OpenAI Whisper returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!isVerboseResponse(parsed)) {
        throw new OpenAIWhisperError(
          res.status,
          false,
          JSON.stringify(parsed),
          'OpenAI Whisper response missing required verbose_json fields',
        );
      }
      return parsed;
    }

    const body = await res.text().catch(() => '');
    const retryable = isRetryableStatus(res.status);
    lastErr = new OpenAIWhisperError(
      res.status,
      retryable,
      body,
      `OpenAI Whisper HTTP ${res.status}: ${body.slice(0, 256)}`,
    );
    if (!retryable) throw lastErr;
    if (attempt + 1 >= totalAttempts) throw lastErr;
    console.warn('transcribeWithOpenAI: retryable HTTP error', {
      attempt,
      status: res.status,
    });
    await sleep(computeBackoff(attempt, backoffBaseMs, random));
  }

  // Unreachable — the loop either returns, throws on non-
  // retryable, or throws on the final retry exhaustion. This
  // throw exists to satisfy the type-checker.
  throw lastErr ?? new Error('transcribeWithOpenAI: exhausted retries with no error captured');
}
