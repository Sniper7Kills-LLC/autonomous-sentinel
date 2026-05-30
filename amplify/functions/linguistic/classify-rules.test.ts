import { describe, expect, it } from 'vitest';
import { classifyWithRules, type RulesMatcher } from './handler';
import type { RuleMatch } from './rules-engine';

/** Engine stub: returns a fixed match (or null) for every transcript. */
function engineReturning(match: RuleMatch | null): RulesMatcher {
  return { tryMatch: () => Promise.resolve(match) };
}

function engineThrowing(): RulesMatcher {
  return {
    tryMatch: () => Promise.reject(new Error('loader boom')),
  };
}

describe('classifyWithRules (#460 slice 1 — rules engine wiring)', () => {
  it('uses a matched rule: type, rule provenance, high confidence, captured fields', async () => {
    const match: RuleMatch = {
      ruleId: 'skyking-v3',
      promptVersion: 3,
      message: {
        messageType: 'SKYKING',
        fields: { sender: 'MAINSAIL', body: 'ALFA BRAVO' },
      },
    };
    const out = await classifyWithRules('skyking skyking ...', engineReturning(match));
    expect(out).toEqual({
      type: 'SKYKING',
      confidence: 0.9,
      rule: 'rule:skyking-v3',
      promptVersion: 3,
      fields: { sender: 'MAINSAIL', body: 'ALFA BRAVO' },
    });
  });

  it('omits empty captured fields rather than passing blanks', async () => {
    const match: RuleMatch = {
      ruleId: 'r1',
      promptVersion: 1,
      message: { messageType: 'ALLSTATIONS', fields: { receiver: 'ALL STATIONS' } },
    };
    const out = await classifyWithRules('all stations ...', engineReturning(match));
    expect(out.fields).toEqual({ receiver: 'ALL STATIONS' });
  });

  it('falls back to the inline classifier when no rule matches', async () => {
    const out = await classifyWithRules('skyking skyking do not answer', engineReturning(null));
    // Inline classify() result — unchanged behavior, zero-seed safe.
    expect(out).toEqual({ type: 'SKYKING', confidence: 0.85, rule: 'skyking-preamble' });
  });

  it('falls back when a matched rule carries an unknown messageType', async () => {
    const match: RuleMatch = {
      ruleId: 'bad',
      promptVersion: 1,
      message: { messageType: 'NONSENSE', fields: {} },
    };
    const out = await classifyWithRules('radio check', engineReturning(match));
    expect(out.type).toBe('RADIOCHECK');
    expect(out.rule).toBe('radio-check');
  });

  it('falls back when the engine throws (loader/DDB failure never sinks a transcript)', async () => {
    const out = await classifyWithRules('all stations', engineThrowing());
    expect(out.type).toBe('ALLSTATIONS');
    expect(out.rule).toBe('all-stations');
  });
});
