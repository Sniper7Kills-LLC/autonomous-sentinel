import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  tryBedrockFallback,
  sanitizeProposedRules,
  buildReconcileSection,
  renderFallbackPrompt,
  DEFAULT_FALLBACK_MODEL_ID,
  DEFAULT_PROMPT_TEMPLATE,
  PARSED_EAM_SCHEMA,
  type ParsedEam,
} from './ai-fallback';

describe('sanitizeProposedRules (#544)', () => {
  it('keeps valid rules and drops bad component / pattern', () => {
    const out = sanitizeProposedRules([
      { component: 'TYPE', pattern: 'SKYKING', messageType: 'SKYKING', confidence: 0.9 },
      { component: 'SENDER', pattern: '(?<sender>\\w+)', captureMap: { sender: 'sender' } },
      { component: 'BOGUS', pattern: 'x' }, // unknown component
      { component: 'BODY', pattern: '(' }, // uncompilable regex
      { component: 'BODY' }, // no pattern
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ component: 'TYPE', confidence: 0.9 });
    expect(out[1]).toMatchObject({ component: 'SENDER', captureMap: { sender: 'sender' } });
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeProposedRules(undefined)).toEqual([]);
    expect(sanitizeProposedRules('nope')).toEqual([]);
  });

  it('drops an over-length (ReDoS-risk) pattern', () => {
    const huge = 'a'.repeat(600);
    expect(sanitizeProposedRules([{ component: 'TYPE', pattern: huge }])).toEqual([]);
  });

  it('drops an out-of-range confidence but keeps the rule', () => {
    const out = sanitizeProposedRules([{ component: 'TYPE', pattern: 'X', confidence: 5 }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeUndefined();
  });
});

/**
 * Behaviour tests for the Bedrock AI fallback helper (#63).
 *
 * Drives `tryBedrockFallback` through a stubbed
 * `BedrockRuntimeClient` so no AWS calls are made. Each test
 * pins one contract surface: tool_use extraction, schema
 * validation, single-corrective-retry, persistent-failure ->
 * null, env-driven model + prompt-template overrides.
 */

interface StubClient {
  client: BedrockRuntimeClient;
  calls: ConverseCommand[];
}

function makeStubClient(responses: Array<ConverseCommandOutput | Error>): StubClient {
  const calls: ConverseCommand[] = [];
  const client = {
    send: (cmd: ConverseCommand): Promise<ConverseCommandOutput> => {
      calls.push(cmd);
      const i = Math.min(calls.length - 1, responses.length - 1);
      const r = responses[i];
      if (r instanceof Error) return Promise.reject(r);
      if (!r) return Promise.reject(new Error('stub: no response queued'));
      return Promise.resolve(r);
    },
  } as unknown as BedrockRuntimeClient;
  return { client, calls };
}

function toolUseResponse(input: Partial<ParsedEam>): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'tu-1',
              name: 'parsed_eam',
              input,
            },
          },
        ],
      },
    },
    stopReason: 'tool_use',
  } as ConverseCommandOutput;
}

function textOnlyResponse(text: string): ConverseCommandOutput {
  return {
    $metadata: {},
    output: {
      message: {
        role: 'assistant',
        content: [{ text }],
      },
    },
    stopReason: 'end_turn',
  } as ConverseCommandOutput;
}

beforeEach(() => {
  delete process.env.LINGUISTIC_FALLBACK_MODEL_ID;
  delete process.env.LINGUISTIC_FALLBACK_PROMPT_VERSION;
  delete process.env.LINGUISTIC_FALLBACK_PROMPT_TEMPLATE;
});

afterEach(() => {
  delete process.env.LINGUISTIC_FALLBACK_MODEL_ID;
  delete process.env.LINGUISTIC_FALLBACK_PROMPT_VERSION;
  delete process.env.LINGUISTIC_FALLBACK_PROMPT_TEMPLATE;
});

describe('buildReconcileSection (#593)', () => {
  it('returns empty string for zero or one transcript (single-source unchanged)', () => {
    expect(buildReconcileSection(undefined)).toBe('');
    expect(buildReconcileSection([])).toBe('');
    expect(buildReconcileSection([{ backend: 'whisper-local', transcript: 'X' }])).toBe('');
  });

  it('builds a reconcile block labelling each transcript by backend + confidence', () => {
    const section = buildReconcileSection([
      { backend: 'whisper-local', transcript: 'OXTRA HOTEL', transcriptionConfidence: 0.71 },
      { backend: 'amazon-transcribe', transcript: 'FOXTROT HOTEL' },
    ]);
    expect(section).toContain('Multiple transcripts — reconcile');
    expect(section).toContain('Transcript 1 — whisper-local (confidence 0.71)');
    expect(section).toContain('OXTRA HOTEL');
    // No confidence reported → no parenthetical.
    expect(section).toContain('Transcript 2 — amazon-transcribe');
    expect(section).not.toContain('Transcript 2 — amazon-transcribe (confidence');
    expect(section).toContain('FOXTROT HOTEL');
  });
});

describe('renderFallbackPrompt — multi-transcript (#593)', () => {
  it('appends the reconcile section only when >1 transcript', () => {
    const single = renderFallbackPrompt('PRIMARY', {
      transcripts: [{ backend: 'whisper-local', transcript: 'PRIMARY' }],
    });
    expect(single.rendered).not.toContain('Multiple transcripts — reconcile');

    const multi = renderFallbackPrompt('PRIMARY', {
      transcripts: [
        { backend: 'whisper-local', transcript: 'PRIMARY' },
        { backend: 'amazon-transcribe', transcript: 'SECOND' },
      ],
    });
    expect(multi.rendered).toContain('Multiple transcripts — reconcile');
    expect(multi.rendered).toContain('SECOND');
  });
});

describe('tryBedrockFallback — multi-transcript reconcile (#593)', () => {
  it('sends the reconcile section in the user prompt when >1 transcript', async () => {
    const { client, calls } = makeStubClient([
      toolUseResponse({ type: 'SKYKING', confidence: 0.9 }),
    ]);
    await tryBedrockFallback('OXTRA HOTEL', {
      client,
      transcripts: [
        { backend: 'whisper-local', transcript: 'OXTRA HOTEL', transcriptionConfidence: 0.7 },
        { backend: 'amazon-transcribe', transcript: 'FOXTROT HOTEL', transcriptionConfidence: 0.9 },
      ],
    });
    const content = calls[0]?.input.messages?.[0]?.content?.[0];
    const text = content && 'text' in content ? (content.text ?? '') : '';
    expect(text).toContain('Multiple transcripts — reconcile');
    expect(text).toContain('FOXTROT HOTEL');
    expect(text).toContain('amazon-transcribe');
  });

  it('leaves the prompt unchanged for a single transcript', async () => {
    const { client, calls } = makeStubClient([toolUseResponse({ type: 'OTHER', confidence: 0.5 })]);
    await tryBedrockFallback('SOLO', {
      client,
      transcripts: [{ backend: 'whisper-local', transcript: 'SOLO' }],
    });
    const content = calls[0]?.input.messages?.[0]?.content?.[0];
    const text = content && 'text' in content ? (content.text ?? '') : '';
    expect(text).not.toContain('Multiple transcripts — reconcile');
  });
});

describe('tryBedrockFallback — happy path', () => {
  it('returns the tool_use payload + default modelId + promptVersion on a valid first response', async () => {
    const { client, calls } = makeStubClient([
      toolUseResponse({
        type: 'SKYKING',
        confidence: 0.92,
        sender: 'SKYKING',
        receiver: 'ALL STATIONS',
        body: 'DELTA OSCAR ECHO',
      }),
    ]);
    const result = await tryBedrockFallback('SKYKING SKYKING DELTA OSCAR ECHO', { client });
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe(DEFAULT_FALLBACK_MODEL_ID);
    expect(result?.promptVersion).toBe(1);
    expect(result?.retried).toBe(false);
    expect(result?.message.type).toBe('SKYKING');
    expect(result?.message.confidence).toBeCloseTo(0.92);
    expect(calls).toHaveLength(1);
  });

  it('returns null on empty / whitespace transcript without invoking Bedrock', async () => {
    const { client, calls } = makeStubClient([]);
    expect(await tryBedrockFallback('', { client })).toBeNull();
    expect(await tryBedrockFallback('   ', { client })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('defaults to a cross-region inference-profile model id (#554)', () => {
    // Claude 4.x on Bedrock is only callable via a cross-region inference
    // profile (`us.`/`global.` prefix), never a bare foundation-model id.
    // A bare/typo id throws "The provided model identifier is invalid" at
    // runtime — lock the form so it can't regress silently.
    expect(DEFAULT_FALLBACK_MODEL_ID).toMatch(/^(us|global|eu|apac)\.anthropic\./);
  });
});

describe('tryBedrockFallback — env overrides', () => {
  it('honours LINGUISTIC_FALLBACK_MODEL_ID env var', async () => {
    process.env.LINGUISTIC_FALLBACK_MODEL_ID = 'amazon.nova-lite-v1:0';
    const { client, calls } = makeStubClient([toolUseResponse({ type: 'OTHER', confidence: 0.5 })]);
    const result = await tryBedrockFallback('test', { client });
    expect(result?.modelId).toBe('amazon.nova-lite-v1:0');
    expect(calls[0]?.input.modelId).toBe('amazon.nova-lite-v1:0');
  });

  it('honours LINGUISTIC_FALLBACK_PROMPT_VERSION env var', async () => {
    process.env.LINGUISTIC_FALLBACK_PROMPT_VERSION = '7';
    const { client } = makeStubClient([toolUseResponse({ type: 'OTHER', confidence: 0.5 })]);
    const result = await tryBedrockFallback('test', { client });
    expect(result?.promptVersion).toBe(7);
  });

  it('appends opts.context AFTER the transcript block (#544b)', async () => {
    const { client, calls } = makeStubClient([toolUseResponse({ type: 'OTHER', confidence: 0.5 })]);
    await tryBedrockFallback('the-transcript', { client, context: 'REFINE-CONTEXT-MARKER' });
    const content = calls[0]?.input.messages?.[0]?.content?.[0];
    const text = content && 'text' in content ? (content.text ?? '') : '';
    expect(text).toContain('the-transcript');
    expect(text).toContain('REFINE-CONTEXT-MARKER');
    // Context lands after the transcript's closing triple-quote.
    expect(text.indexOf('REFINE-CONTEXT-MARKER')).toBeGreaterThan(text.lastIndexOf('"""'));
  });

  it('throws if a custom prompt template lacks the {{TRANSCRIPT}} placeholder', async () => {
    const { client } = makeStubClient([toolUseResponse({ type: 'OTHER', confidence: 0.5 })]);
    await expect(
      tryBedrockFallback('test', { client, promptTemplate: 'no placeholder here' }),
    ).rejects.toThrow(/\{\{TRANSCRIPT\}\}/);
  });

  it('uses the default prompt template when no override is provided', async () => {
    const { client, calls } = makeStubClient([toolUseResponse({ type: 'OTHER', confidence: 0.5 })]);
    await tryBedrockFallback('transcript-body-here', { client });
    const messages = calls[0]?.input.messages;
    const userText = messages?.[0]?.content?.[0];
    if (!userText || !('text' in userText)) throw new Error('expected text content');
    expect(userText.text).toContain('transcript-body-here');
    expect(DEFAULT_PROMPT_TEMPLATE).toContain('{{TRANSCRIPT}}');
  });
});

describe('tryBedrockFallback — schema-invalid retry', () => {
  it('retries once when the first response is text-only (no tool_use)', async () => {
    const { client, calls } = makeStubClient([
      textOnlyResponse('Sorry I cannot help with that'),
      toolUseResponse({ type: 'OTHER', confidence: 0.6 }),
    ]);
    const result = await tryBedrockFallback('test', { client });
    expect(result).not.toBeNull();
    expect(result?.retried).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries once when the first response has a malformed tool_use payload', async () => {
    const { client, calls } = makeStubClient([
      // confidence > 1 → fails schema validation
      toolUseResponse({ type: 'OTHER', confidence: 1.5 }),
      toolUseResponse({ type: 'OTHER', confidence: 0.7 }),
    ]);
    const result = await tryBedrockFallback('test', { client });
    expect(result?.retried).toBe(true);
    expect(result?.message.confidence).toBeCloseTo(0.7);
    expect(calls).toHaveLength(2);
  });

  it('returns null when the corrective retry also fails schema validation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, calls } = makeStubClient([
      textOnlyResponse('first reject'),
      textOnlyResponse('second reject — still no tool call'),
    ]);
    const result = await tryBedrockFallback('test', { client });
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('tryBedrockFallback — Bedrock errors', () => {
  it('retries once and returns null when both attempts throw (no SQS-retry spam) (#577)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Stub clamps to the last response → both the first attempt and the
    // transient retry throw → null after 2 calls.
    const { client, calls } = makeStubClient([new Error('ThrottlingException')]);
    const result = await tryBedrockFallback('test', { client });
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('retries once and succeeds on a transient first-attempt throw (#577)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, calls } = makeStubClient([
      new Error('Bedrock is unable to process your request.'),
      toolUseResponse({ type: 'SKYKING', confidence: 0.9 }),
    ]);
    const result = await tryBedrockFallback('skyking skyking do not answer', { client });
    expect(result).not.toBeNull();
    expect(result?.message.type).toBe('SKYKING');
    // Transient retry is NOT the schema-corrective retry.
    expect(result?.retried).toBe(false);
    expect(calls).toHaveLength(2);
    warnSpy.mockRestore();
  });

  it('returns null when Bedrock throws on the corrective retry', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, calls } = makeStubClient([
      textOnlyResponse('reject'),
      new Error('ServiceUnavailable'),
    ]);
    const result = await tryBedrockFallback('test', { client });
    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
    warnSpy.mockRestore();
  });
});

describe('tryBedrockFallback — schema definition', () => {
  it('pins required fields + type enum', () => {
    expect(PARSED_EAM_SCHEMA.required).toEqual(['type', 'confidence']);
    expect(PARSED_EAM_SCHEMA.properties.type.enum).toEqual([
      'BACKEND',
      'SKYKING',
      'ALLSTATIONS',
      'RADIOCHECK',
      'SKYMASTER',
      'SKYBIRD',
      'DISREGARDED',
      'OTHER',
    ]);
  });

  it('constrains confidence to the 0-1 range so downstream threshold logic (#65) holds', () => {
    expect(PARSED_EAM_SCHEMA.properties.confidence.minimum).toBe(0);
    expect(PARSED_EAM_SCHEMA.properties.confidence.maximum).toBe(1);
  });
});
