import { describe, it, expect, vi } from 'vitest';
import {
  buildTraceRow,
  applySizeGuard,
  persistTrace,
  MAX_INLINE_TRACE_BYTES,
  TRACE_TTL_DAYS_DEFAULT,
  type TraceInput,
} from './trace';

const FIXED_NOW = new Date('2026-06-06T00:00:00.000Z');
const now = () => FIXED_NOW;

function baseInput(overrides: Partial<TraceInput> = {}): TraceInput {
  return {
    recordingId: 'rec-1',
    runAt: '2026-06-06T00:00:00.000Z',
    triggerBackend: 'whisper-local',
    transcriptSnapshot: 'SKYKING ABC123',
    rulesEvaluated: [{ ruleId: 't', matched: true }],
    rulesOutcome: { ruleId: 't', messageType: 'SKYKING' },
    bedrock: null,
    finalResult: { type: 'SKYKING', source: 'rules', confidence: 0.9 },
    attemptSuccess: true,
    resultHash: 'rh',
    promptHash: null,
    ...overrides,
  };
}

describe('buildTraceRow (#744)', () => {
  it('stringifies json columns and computes a 90-day TTL', () => {
    const row = buildTraceRow(baseInput(), { now });
    expect(row.recordingId).toBe('rec-1');
    expect(JSON.parse(row.rulesEvaluated)).toEqual([{ ruleId: 't', matched: true }]);
    expect(JSON.parse(row.finalResult)).toMatchObject({ type: 'SKYKING' });
    const expectedTtl = Math.floor(FIXED_NOW.getTime() / 1000) + TRACE_TTL_DAYS_DEFAULT * 86_400;
    expect(row.ttl).toBe(expectedTtl);
    expect(row.truncated).toBe(false);
    expect(JSON.parse(row.overflowKeys)).toEqual({});
  });

  it('marks bedrockInvoked=false and nulls bedrock columns when AI did not run', () => {
    const row = buildTraceRow(baseInput({ bedrock: null }), { now });
    expect(row.bedrockInvoked).toBe(false);
    expect(row.bedrockModelId).toBeNull();
    expect(row.bedrockRenderedPrompt).toBeNull();
    expect(row.bedrockRawResponse).toBeNull();
  });

  it('captures the bedrock request/response when AI ran', () => {
    const row = buildTraceRow(
      baseInput({
        bedrock: {
          modelId: 'us.anthropic.claude-opus-4-8',
          promptVersion: 3,
          promptHash: 'ph',
          renderedPrompt: 'PROMPT TEXT',
          rawResponse: { output: { message: {} } },
          parsed: { type: 'OTHER', confidence: 0.6, retried: false },
          proposedRules: [{ component: 'TYPE', pattern: 'X' }],
        },
      }),
      { now },
    );
    expect(row.bedrockInvoked).toBe(true);
    expect(row.bedrockModelId).toBe('us.anthropic.claude-opus-4-8');
    expect(row.bedrockPromptVersion).toBe(3);
    expect(row.bedrockRenderedPrompt).toBe('PROMPT TEXT');
    expect(JSON.parse(row.bedrockRawResponse as string)).toMatchObject({ output: {} });
    expect(JSON.parse(row.bedrockProposedRules as string)).toHaveLength(1);
  });
});

describe('applySizeGuard (#744)', () => {
  it('leaves a small row inline (no spill)', async () => {
    const row = buildTraceRow(baseInput(), { now });
    const putObject = vi.fn();
    const guarded = await applySizeGuard(row, { putObject, bucket: 'b' });
    expect(guarded).toEqual(row);
    expect(putObject).not.toHaveBeenCalled();
  });

  it('spills the large fields to S3 when over the threshold', async () => {
    const huge = 'x'.repeat(MAX_INLINE_TRACE_BYTES + 10);
    const row = buildTraceRow(
      baseInput({
        bedrock: {
          modelId: 'm',
          promptVersion: 1,
          promptHash: 'ph',
          renderedPrompt: huge,
          rawResponse: { big: huge },
          parsed: { type: 'OTHER', confidence: 0.5 },
          proposedRules: [],
        },
      }),
      { now },
    );
    const putObject = vi.fn<(key: string, body: string) => Promise<void>>(() => Promise.resolve());
    const guarded = await applySizeGuard(row, { putObject, bucket: 'my-bucket' });

    expect(guarded.truncated).toBe(true);
    expect(guarded.bedrockRenderedPrompt).toBeNull();
    expect(guarded.bedrockRawResponse).toBeNull();
    const overflow = JSON.parse(guarded.overflowKeys) as Record<string, string>;
    expect(overflow.renderedPrompt).toBe('diagnostics/rec-1/2026-06-06T00:00:00.000Z-prompt.txt');
    expect(overflow.rawResponse).toBe('diagnostics/rec-1/2026-06-06T00:00:00.000Z-response.json');
    expect(putObject).toHaveBeenCalledTimes(2);
  });

  it('drops the large fields (no data loss elsewhere) when oversized but no bucket', async () => {
    const huge = 'x'.repeat(MAX_INLINE_TRACE_BYTES + 10);
    const row = buildTraceRow(
      baseInput({
        bedrock: {
          modelId: 'm',
          promptVersion: 1,
          promptHash: 'ph',
          renderedPrompt: huge,
          rawResponse: null,
          parsed: null,
          proposedRules: [],
        },
      }),
      { now },
    );
    const guarded = await applySizeGuard(row, {});
    expect(guarded.truncated).toBe(true);
    expect(guarded.bedrockRenderedPrompt).toBeNull();
    // Row still has its small fields intact so the trace is not lost entirely.
    expect(guarded.recordingId).toBe('rec-1');
    expect(JSON.parse(guarded.overflowKeys)).toEqual({});
  });
});

describe('persistTrace (#744)', () => {
  it('writes the guarded row via the data client', async () => {
    const create = vi.fn(() => Promise.resolve({ data: { id: 'x' }, errors: undefined }));
    await persistTrace({ models: { LinguisticTrace: { create } } }, baseInput(), { now });
    expect(create).toHaveBeenCalledOnce();
    const row = (create.mock.calls[0] as unknown[])?.[0] as { recordingId: string };
    expect(row.recordingId).toBe('rec-1');
  });

  it('swallows a create error (best-effort, never throws)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const create = vi.fn(() => Promise.resolve({ errors: [{ message: 'boom' }] }));
    await expect(
      persistTrace({ models: { LinguisticTrace: { create } } }, baseInput(), { now }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows a thrown error (best-effort, never throws)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const create = vi.fn(() => Promise.reject(new Error('network down')));
    await expect(
      persistTrace({ models: { LinguisticTrace: { create } } }, baseInput(), { now }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
