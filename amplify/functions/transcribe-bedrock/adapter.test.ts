import { describe, it, expect, vi } from 'vitest';
import type {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  BedrockAdapterError,
  BedrockMultimodalNotSupported,
  ClaudeAudioAdapter,
  DEFAULT_TRANSCRIBE_PROMPT,
  StubAdapter,
  selectAdapter,
  type BedrockAudioRequest,
} from './adapter';

/**
 * Behaviour tests for the Bedrock multimodal adapter (#57).
 *
 * Pins the stub-throws-pre-GA contract, the ClaudeAudioAdapter
 * request shape + response parsing, the selectAdapter factory
 * flag behaviour, and the misconfig fail-fast paths.
 */

interface StubBedrock {
  client: BedrockRuntimeClient;
  calls: ConverseCommand[];
}

function stubBedrock(responses: Array<ConverseCommandOutput | Error>): StubBedrock {
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

function textResponse(text: string): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
  } as ConverseCommandOutput;
}

const sampleRequest = (overrides: Partial<BedrockAudioRequest> = {}): BedrockAudioRequest => ({
  recordingId: 'rec-1',
  audioBytes: new Uint8Array([1, 2, 3, 4, 5]),
  ...overrides,
});

describe('StubAdapter', () => {
  it('throws BedrockMultimodalNotSupported on transcribe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new StubAdapter();
    await expect(adapter.transcribe(sampleRequest())).rejects.toBeInstanceOf(
      BedrockMultimodalNotSupported,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('error name is BedrockMultimodalNotSupported for catch-by-name handlers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new StubAdapter();
    try {
      await adapter.transcribe(sampleRequest());
    } catch (err) {
      expect((err as Error).name).toBe('BedrockMultimodalNotSupported');
    }
    warn.mockRestore();
  });
});

describe('ClaudeAudioAdapter — request shape', () => {
  it('sends a ConverseCommand with the configured modelId + a user message', async () => {
    const { client, calls } = stubBedrock([textResponse('SKYKING SKYKING')]);
    const adapter = new ClaudeAudioAdapter({ modelId: 'anthropic.claude-sonnet-4-7', client });
    await adapter.transcribe(sampleRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.modelId).toBe('anthropic.claude-sonnet-4-7');
    expect(calls[0]?.input.messages?.[0]?.role).toBe('user');
  });

  it('embeds the default prompt + language hint + MIME in the user message', async () => {
    const { client, calls } = stubBedrock([textResponse('ok')]);
    const adapter = new ClaudeAudioAdapter({ modelId: 'm', client });
    await adapter.transcribe(sampleRequest());
    const block = calls[0]?.input.messages?.[0]?.content?.[0];
    if (!block || !('text' in block) || typeof block.text !== 'string') {
      throw new Error('expected a text content block');
    }
    expect(block.text).toContain(DEFAULT_TRANSCRIBE_PROMPT);
    expect(block.text).toContain('Language hint: en');
    expect(block.text).toContain('MIME: audio/ogg');
  });

  it('honours overriding prompt + language + mimeType', async () => {
    const { client, calls } = stubBedrock([textResponse('ok')]);
    const adapter = new ClaudeAudioAdapter({ modelId: 'm', client });
    await adapter.transcribe(
      sampleRequest({ prompt: 'custom-prompt', language: 'es', mimeType: 'audio/wav' }),
    );
    const block = calls[0]?.input.messages?.[0]?.content?.[0];
    if (!block || !('text' in block) || typeof block.text !== 'string') {
      throw new Error('expected a text content block');
    }
    expect(block.text).toContain('custom-prompt');
    expect(block.text).toContain('Language hint: es');
    expect(block.text).toContain('MIME: audio/wav');
  });
});

describe('ClaudeAudioAdapter — response parsing', () => {
  it('returns the joined text + language + modelId on a normal response', async () => {
    const { client } = stubBedrock([textResponse('SKYKING DELTA OSCAR')]);
    const adapter = new ClaudeAudioAdapter({ modelId: 'm', client });
    const result = await adapter.transcribe(sampleRequest({ language: 'en' }));
    expect(result).toEqual({
      text: 'SKYKING DELTA OSCAR',
      language: 'en',
      modelId: 'm',
    });
  });

  it('concatenates multiple text blocks (e.g. streaming-joined responses)', async () => {
    const { client } = stubBedrock([
      {
        $metadata: {},
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'part-A ' }, { text: 'part-B' }],
          },
        },
        stopReason: 'end_turn',
      } as ConverseCommandOutput,
    ]);
    const adapter = new ClaudeAudioAdapter({ modelId: 'm', client });
    const result = await adapter.transcribe(sampleRequest());
    expect(result.text).toBe('part-A part-B');
  });

  it('throws BedrockAdapterError when the response has no text content', async () => {
    const { client } = stubBedrock([
      {
        $metadata: {},
        output: { message: { role: 'assistant', content: [] } },
        stopReason: 'end_turn',
      } as unknown as ConverseCommandOutput,
    ]);
    const adapter = new ClaudeAudioAdapter({ modelId: 'm', client });
    await expect(adapter.transcribe(sampleRequest())).rejects.toBeInstanceOf(BedrockAdapterError);
  });

  it('wraps an SDK throw in BedrockAdapterError with modelId + cause', async () => {
    const sdkErr = new Error('ThrottlingException');
    const { client } = stubBedrock([sdkErr]);
    const adapter = new ClaudeAudioAdapter({ modelId: 'm', client });
    await expect(adapter.transcribe(sampleRequest())).rejects.toMatchObject({
      name: 'BedrockAdapterError',
      modelId: 'm',
      cause: sdkErr,
    });
  });
});

describe('selectAdapter factory', () => {
  it('returns StubAdapter by default (flag missing)', () => {
    const adapter = selectAdapter({ env: {} });
    expect(adapter).toBeInstanceOf(StubAdapter);
  });

  it('returns StubAdapter when flag is anything other than "true"', () => {
    expect(selectAdapter({ env: { BEDROCK_AUDIO_ENABLED: 'false' } })).toBeInstanceOf(StubAdapter);
    expect(selectAdapter({ env: { BEDROCK_AUDIO_ENABLED: 'TRUE' } })).toBeInstanceOf(StubAdapter);
    expect(selectAdapter({ env: { BEDROCK_AUDIO_ENABLED: '1' } })).toBeInstanceOf(StubAdapter);
  });

  it('returns ClaudeAudioAdapter when flag is "true" and model id is set', () => {
    const { client } = stubBedrock([]);
    const adapter = selectAdapter({
      env: { BEDROCK_AUDIO_ENABLED: 'true', BEDROCK_MODEL_ID: 'anthropic.claude' },
      client,
    });
    expect(adapter).toBeInstanceOf(ClaudeAudioAdapter);
  });

  it('throws at cold start when flag is on but model id is missing', () => {
    expect(() => selectAdapter({ env: { BEDROCK_AUDIO_ENABLED: 'true' } })).toThrow(
      /BEDROCK_MODEL_ID/,
    );
  });
});
