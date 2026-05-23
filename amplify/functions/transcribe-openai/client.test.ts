import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_WHISPER_MODEL,
  OpenAIWhisperError,
  transcribeWithOpenAI,
  type WhisperVerboseResponse,
} from './client';

/**
 * Behaviour tests for the OpenAI Whisper API client (#55).
 *
 * Drives `transcribeWithOpenAI` through a stub `fetch` so no
 * real HTTP is issued. Each test pins one contract surface:
 * happy path, retry on 429 / 5xx, non-retryable 4xx, retry
 * exhaustion, network error, malformed response, multipart
 * body shape, env-driven model + base-url overrides.
 */

const VALID_BODY: WhisperVerboseResponse = {
  text: 'SKYKING SKYKING DELTA ALPHA',
  language: 'en',
  duration: 4.2,
  words: [
    { word: 'SKYKING', start: 0.0, end: 0.5 },
    { word: 'SKYKING', start: 0.6, end: 1.1 },
    { word: 'DELTA', start: 1.2, end: 1.6 },
    { word: 'ALPHA', start: 1.7, end: 2.1 },
  ],
};

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textErr(status: number, body = ''): Response {
  return new Response(body, { status });
}

interface FetchRecord {
  url: string;
  init?: RequestInit;
}

function stubFetch(responses: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: FetchRecord[];
} {
  const calls: FetchRecord[] = [];
  const fn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const i = Math.min(calls.length - 1, responses.length - 1);
    const r = responses[i];
    if (r instanceof Error) return Promise.reject(r);
    if (!r) return Promise.reject(new Error('stubFetch: no response queued'));
    return Promise.resolve(r);
  };
  return { fetch: fn, calls };
}

const audio = (): Uint8Array => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
const random = (): number => 0; // deterministic backoff for assertions

describe('transcribeWithOpenAI — happy path', () => {
  it('returns the parsed verbose_json on a 200 response', async () => {
    const { fetch, calls } = stubFetch([jsonOk(VALID_BODY)]);
    const result = await transcribeWithOpenAI(audio(), {
      apiKey: 'sk-test',
      fetch,
      sleep,
      random,
    });
    expect(result).toEqual(VALID_BODY);
    expect(calls).toHaveLength(1);
  });

  it('POSTs to the default base URL + path with the Bearer token', async () => {
    const { fetch, calls } = stubFetch([jsonOk(VALID_BODY)]);
    await transcribeWithOpenAI(audio(), { apiKey: 'sk-xyz', fetch, sleep, random });
    expect(calls[0]?.url).toBe(`${DEFAULT_OPENAI_BASE_URL}/v1/audio/transcriptions`);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-xyz');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('encodes the audio + form fields in a multipart body', async () => {
    const { fetch, calls } = stubFetch([jsonOk(VALID_BODY)]);
    await transcribeWithOpenAI(audio(), { apiKey: 'k', fetch, sleep, random });
    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('model')).toBe(DEFAULT_OPENAI_WHISPER_MODEL);
    expect(form.get('language')).toBe('en');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('timestamp_granularities[]')).toBe('word');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('honours model, language, baseUrl, fileName, mimeType overrides', async () => {
    const { fetch, calls } = stubFetch([jsonOk({ ...VALID_BODY, language: 'es' })]);
    const result = await transcribeWithOpenAI(audio(), {
      apiKey: 'k',
      model: 'whisper-large-v3',
      language: 'es',
      baseUrl: 'https://proxy.internal',
      fileName: 'rec-abc.opus',
      mimeType: 'audio/wav',
      fetch,
      sleep,
      random,
    });
    expect(calls[0]?.url).toBe('https://proxy.internal/v1/audio/transcriptions');
    const form = calls[0]?.init?.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('es');
    expect(result.language).toBe('es');
  });
});

describe('transcribeWithOpenAI — argument validation', () => {
  it('throws when apiKey is missing', async () => {
    await expect(
      transcribeWithOpenAI(audio(), { apiKey: '', fetch: stubFetch([]).fetch, sleep, random }),
    ).rejects.toThrow(/apiKey/);
  });

  it('throws when audioBytes is empty', async () => {
    await expect(
      transcribeWithOpenAI(new Uint8Array(0), {
        apiKey: 'k',
        fetch: stubFetch([]).fetch,
        sleep,
        random,
      }),
    ).rejects.toThrow(/audioBytes/);
  });
});

describe('transcribeWithOpenAI — retry on 429 / 5xx', () => {
  it('retries on 429 and returns once the call succeeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch, calls } = stubFetch([textErr(429, 'rate-limited'), jsonOk(VALID_BODY)]);
    const localSleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const result = await transcribeWithOpenAI(audio(), {
      apiKey: 'k',
      fetch,
      sleep: localSleep,
      random,
    });
    expect(result.text).toBe(VALID_BODY.text);
    expect(calls).toHaveLength(2);
    expect(localSleep).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('retries on 503 (server error) the same way', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch, calls } = stubFetch([textErr(503), jsonOk(VALID_BODY)]);
    const result = await transcribeWithOpenAI(audio(), {
      apiKey: 'k',
      fetch,
      sleep,
      random,
    });
    expect(result).toEqual(VALID_BODY);
    expect(calls).toHaveLength(2);
    warnSpy.mockRestore();
  });

  it('throws OpenAIWhisperError(retryable=true, status=429) when retries are exhausted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch, calls } = stubFetch([textErr(429), textErr(429), textErr(429), textErr(429)]);
    await expect(
      transcribeWithOpenAI(audio(), {
        apiKey: 'k',
        fetch,
        sleep,
        random,
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({
      name: 'OpenAIWhisperError',
      status: 429,
      retryable: true,
    });
    // 1 initial + 3 retries
    expect(calls).toHaveLength(4);
    warnSpy.mockRestore();
  });
});

describe('transcribeWithOpenAI — non-retryable 4xx', () => {
  it('throws immediately on 401 (unauthorized) without retrying', async () => {
    const { fetch, calls } = stubFetch([textErr(401, 'invalid_api_key')]);
    await expect(
      transcribeWithOpenAI(audio(), { apiKey: 'k', fetch, sleep, random }),
    ).rejects.toMatchObject({
      name: 'OpenAIWhisperError',
      status: 401,
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('throws immediately on 413 (payload too large)', async () => {
    const { fetch, calls } = stubFetch([textErr(413)]);
    await expect(
      transcribeWithOpenAI(audio(), { apiKey: 'k', fetch, sleep, random }),
    ).rejects.toMatchObject({ status: 413, retryable: false });
    expect(calls).toHaveLength(1);
  });
});

describe('transcribeWithOpenAI — network errors', () => {
  it('retries on a fetch-thrown network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch, calls } = stubFetch([new Error('ECONNRESET'), jsonOk(VALID_BODY)]);
    const result = await transcribeWithOpenAI(audio(), {
      apiKey: 'k',
      fetch,
      sleep,
      random,
    });
    expect(result).toEqual(VALID_BODY);
    expect(calls).toHaveLength(2);
    warnSpy.mockRestore();
  });

  it('throws OpenAIWhisperError(status=0, retryable=true) when network errors exhaust retries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetch } = stubFetch([
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
      new Error('ECONNRESET'),
    ]);
    await expect(
      transcribeWithOpenAI(audio(), {
        apiKey: 'k',
        fetch,
        sleep,
        random,
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({
      name: 'OpenAIWhisperError',
      status: 0,
      retryable: true,
    });
    warnSpy.mockRestore();
  });
});

describe('transcribeWithOpenAI — malformed response', () => {
  it('throws when the 200 body is not valid JSON', async () => {
    const { fetch } = stubFetch([new Response('<<not-json>>', { status: 200 })]);
    await expect(
      transcribeWithOpenAI(audio(), { apiKey: 'k', fetch, sleep, random }),
    ).rejects.toBeInstanceOf(OpenAIWhisperError);
  });

  it('throws when the 200 body is missing required verbose_json fields', async () => {
    const { fetch } = stubFetch([jsonOk({ text: 'ok' })]); // no language, no duration
    await expect(
      transcribeWithOpenAI(audio(), { apiKey: 'k', fetch, sleep, random }),
    ).rejects.toThrow(/verbose_json/);
  });
});

describe('transcribeWithOpenAI — backoff sleep', () => {
  it('sleeps between retries with computed exponential delay', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sleepFn = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    const { fetch } = stubFetch([textErr(429), textErr(429), jsonOk(VALID_BODY)]);
    await transcribeWithOpenAI(audio(), {
      apiKey: 'k',
      fetch,
      sleep: sleepFn,
      random,
      backoffBaseMs: 100,
    });
    expect(sleepFn).toHaveBeenCalledTimes(2);
    // attempt 0 sleep: 100 * 2^0 + 0 = 100; attempt 1 sleep: 100 * 2^1 + 0 = 200
    expect(sleepFn.mock.calls[0]?.[0]).toBe(100);
    expect(sleepFn.mock.calls[1]?.[0]).toBe(200);
    warnSpy.mockRestore();
  });
});
