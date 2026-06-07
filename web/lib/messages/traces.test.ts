import { describe, it, expect } from 'vitest';
import { toDisplayTrace } from './traces';

describe('toDisplayTrace (#745)', () => {
  it('parses json columns delivered as strings', () => {
    const t = toDisplayTrace({
      id: 'trace-1',
      recordingId: 'rec-1',
      runAt: '2026-06-06T00:00:00.000Z',
      triggerBackend: 'whisper-local',
      transcriptSnapshot: 'SKYKING ABC',
      rulesEvaluated: JSON.stringify([
        {
          ruleId: 'r1',
          component: 'TYPE',
          messageType: 'SKYKING',
          appliesToType: null,
          pattern: 'SKYKING',
          confidence: 0.9,
          matched: true,
          matchedText: 'SKYKING',
          captures: { sender: 'MAINSAIL' },
        },
      ]),
      rulesOutcome: JSON.stringify({ ruleId: 'r1', messageType: 'SKYKING' }),
      bedrockInvoked: true,
      bedrockModelId: 'us.anthropic.claude-opus-4-8',
      bedrockPromptVersion: 2,
      bedrockRenderedPrompt: 'PROMPT',
      bedrockRawResponse: JSON.stringify({ output: { message: {} } }),
      finalResult: JSON.stringify({ type: 'SKYKING', source: 'bedrock' }),
      attemptSuccess: true,
      overflowKeys: JSON.stringify({ renderedPrompt: 'diagnostics/rec-1/x-prompt.txt' }),
      truncated: true,
    });

    expect(t.rulesEvaluated).toHaveLength(1);
    expect(t.rulesEvaluated[0]?.captures).toEqual({ sender: 'MAINSAIL' });
    expect(t.rulesOutcome).toMatchObject({ messageType: 'SKYKING' });
    expect(t.bedrockInvoked).toBe(true);
    expect(t.bedrockPromptVersion).toBe(2);
    expect(t.finalResult).toMatchObject({ type: 'SKYKING', source: 'bedrock' });
    expect(t.overflowKeys.renderedPrompt).toBe('diagnostics/rec-1/x-prompt.txt');
    expect(t.truncated).toBe(true);
  });

  it('accepts json columns delivered already-parsed (objects)', () => {
    const t = toDisplayTrace({
      id: 'trace-2',
      recordingId: 'rec-2',
      runAt: '2026-06-06T01:00:00.000Z',
      rulesEvaluated: [{ ruleId: 'r2', pattern: 'X', matched: false }],
      finalResult: { type: 'OTHER' },
    });
    expect(t.rulesEvaluated[0]?.ruleId).toBe('r2');
    expect(t.rulesEvaluated[0]?.matched).toBe(false);
    expect(t.finalResult).toMatchObject({ type: 'OTHER' });
  });

  it('defaults missing/null fields safely', () => {
    const t = toDisplayTrace({ id: 't', recordingId: 'r', runAt: '2026-01-01T00:00:00Z' });
    expect(t.rulesEvaluated).toEqual([]);
    expect(t.bedrockInvoked).toBe(false);
    expect(t.bedrockRenderedPrompt).toBeNull();
    expect(t.overflowKeys).toEqual({});
    expect(t.truncated).toBe(false);
    expect(t.attemptSuccess).toBeNull();
  });

  it('tolerates malformed json strings (treats as null/empty)', () => {
    const t = toDisplayTrace({
      id: 't',
      recordingId: 'r',
      runAt: '2026-01-01T00:00:00Z',
      rulesEvaluated: '{not json',
      finalResult: '{bad',
    });
    expect(t.rulesEvaluated).toEqual([]);
    expect(t.finalResult).toBeNull();
  });
});
