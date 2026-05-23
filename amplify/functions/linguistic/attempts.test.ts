import { describe, it, expect } from 'vitest';
import {
  appendAttempt,
  hashPrompt,
  hashResult,
  lastSuccessfulResult,
  shouldSkip,
  type LinguisticAttempt,
} from './attempts';

/**
 * Behaviour tests for the linguistic_attempts log helpers (#64).
 *
 * Each test pins one contract surface: SHA-256 determinism,
 * shouldSkip semantics (only matches successful + identical
 * triple), lastSuccessfulResult most-recent selection,
 * appendAttempt immutability + ts-default.
 */

function attempt(overrides: Partial<LinguisticAttempt>): LinguisticAttempt {
  return {
    provider: 'bedrock',
    promptVersion: 1,
    promptHash: 'aaa',
    resultHash: 'rrr',
    success: true,
    ts: '2026-05-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('hashPrompt / hashResult', () => {
  it('returns a deterministic 64-char hex digest for the same input', () => {
    const h1 = hashPrompt('hello world');
    const h2 = hashPrompt('hello world');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs across distinct inputs', () => {
    expect(hashPrompt('a')).not.toBe(hashPrompt('b'));
    expect(hashResult('{"x":1}')).not.toBe(hashResult('{"x":2}'));
  });

  it('hashPrompt and hashResult are separately addressable but both SHA-256', () => {
    // Same input through both produces the same digest — they're
    // both SHA-256 wrappers, the function name is a contract label
    // for the caller, not a different algorithm.
    expect(hashPrompt('same-bytes')).toBe(hashResult('same-bytes'));
  });
});

describe('shouldSkip', () => {
  it('returns false on null / empty attempt log', () => {
    expect(shouldSkip(null, { provider: 'bedrock', promptVersion: 1, promptHash: 'h' })).toBe(
      false,
    );
    expect(shouldSkip([], { provider: 'bedrock', promptVersion: 1, promptHash: 'h' })).toBe(false);
  });

  it('returns true on an exact-triple successful prior attempt', () => {
    const attempts = [attempt({ provider: 'bedrock', promptVersion: 1, promptHash: 'h' })];
    expect(shouldSkip(attempts, { provider: 'bedrock', promptVersion: 1, promptHash: 'h' })).toBe(
      true,
    );
  });

  it('returns false when the prior attempt had success=false (failed runs DO retry)', () => {
    const attempts = [
      attempt({
        provider: 'bedrock',
        promptVersion: 1,
        promptHash: 'h',
        success: false,
        resultHash: null,
      }),
    ];
    expect(shouldSkip(attempts, { provider: 'bedrock', promptVersion: 1, promptHash: 'h' })).toBe(
      false,
    );
  });

  it('returns false when promptVersion differs (bumping the version triggers re-run)', () => {
    const attempts = [attempt({ provider: 'bedrock', promptVersion: 1, promptHash: 'h' })];
    expect(shouldSkip(attempts, { provider: 'bedrock', promptVersion: 2, promptHash: 'h' })).toBe(
      false,
    );
  });

  it('returns false when promptHash differs (editing the template body triggers re-run)', () => {
    const attempts = [attempt({ provider: 'bedrock', promptVersion: 1, promptHash: 'h-old' })];
    expect(
      shouldSkip(attempts, { provider: 'bedrock', promptVersion: 1, promptHash: 'h-new' }),
    ).toBe(false);
  });

  it('returns false when provider differs (rules path success does not skip Bedrock path)', () => {
    const attempts = [attempt({ provider: 'rules', promptVersion: 1, promptHash: null })];
    expect(shouldSkip(attempts, { provider: 'bedrock', promptVersion: 1, promptHash: null })).toBe(
      false,
    );
  });
});

describe('lastSuccessfulResult', () => {
  it('returns undefined on empty / no-match', () => {
    expect(
      lastSuccessfulResult([], { provider: 'bedrock', promptVersion: 1, promptHash: 'h' }),
    ).toBeUndefined();
  });

  it('returns the only matching successful attempt', () => {
    const a = attempt({ ts: '2026-05-01T00:00:00.000Z' });
    expect(
      lastSuccessfulResult([a], {
        provider: 'bedrock',
        promptVersion: 1,
        promptHash: 'aaa',
      }),
    ).toBe(a);
  });

  it('returns the most-recent (ts-max) on multiple matches', () => {
    const older = attempt({ ts: '2026-01-01T00:00:00.000Z', resultHash: 'old' });
    const newer = attempt({ ts: '2026-05-23T00:00:00.000Z', resultHash: 'new' });
    const result = lastSuccessfulResult([older, newer], {
      provider: 'bedrock',
      promptVersion: 1,
      promptHash: 'aaa',
    });
    expect(result?.resultHash).toBe('new');
  });

  it('ignores failed attempts even when triple matches', () => {
    const failed = attempt({ success: false, resultHash: null });
    expect(
      lastSuccessfulResult([failed], {
        provider: 'bedrock',
        promptVersion: 1,
        promptHash: 'aaa',
      }),
    ).toBeUndefined();
  });
});

describe('appendAttempt', () => {
  it('returns a new array; does not mutate the original', () => {
    const original: LinguisticAttempt[] = [];
    const next = appendAttempt(original, {
      provider: 'bedrock',
      promptVersion: 1,
      promptHash: 'h',
      resultHash: 'r',
      success: true,
    });
    expect(next).toHaveLength(1);
    expect(original).toHaveLength(0);
    expect(next).not.toBe(original);
  });

  it('treats null / undefined input as an empty log', () => {
    const next = appendAttempt(null, {
      provider: 'rules',
      promptVersion: 3,
      promptHash: null,
      resultHash: 'r',
      success: true,
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.provider).toBe('rules');
  });

  it('uses an injected now() for a deterministic ts when no ts override provided', () => {
    const fixed = new Date('2026-05-23T12:34:56.789Z');
    const next = appendAttempt(
      [],
      {
        provider: 'bedrock',
        promptVersion: 1,
        promptHash: 'h',
        resultHash: 'r',
        success: false,
      },
      { now: () => fixed },
    );
    expect(next[0]?.ts).toBe('2026-05-23T12:34:56.789Z');
  });

  it('honours an explicit ts override on the attempt itself', () => {
    const next = appendAttempt([], {
      provider: 'bedrock',
      promptVersion: 1,
      promptHash: 'h',
      resultHash: 'r',
      success: true,
      ts: '2020-01-01T00:00:00.000Z',
    });
    expect(next[0]?.ts).toBe('2020-01-01T00:00:00.000Z');
  });

  it('preserves the existing log order and appends at the end', () => {
    const first = attempt({ ts: '2026-01-01T00:00:00.000Z' });
    const next = appendAttempt([first], {
      provider: 'bedrock',
      promptVersion: 2,
      promptHash: 'h2',
      resultHash: 'r2',
      success: true,
      ts: '2026-05-23T00:00:00.000Z',
    });
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(first);
    expect(next[1]?.promptVersion).toBe(2);
  });
});
