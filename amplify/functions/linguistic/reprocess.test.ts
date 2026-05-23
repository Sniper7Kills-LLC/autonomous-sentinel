import { describe, it, expect } from 'vitest';
import type { LinguisticAttempt } from './attempts';
import {
  ReprocessReason,
  buildReprocessMessage,
  selectForReprocess,
  shouldReprocess,
  type ReprocessCandidate,
} from './reprocess';

/**
 * Behaviour tests for the reprocess-on-bump selector (#66).
 *
 * Pins the "never reprocess a previously-successful Recording"
 * guard from CLAUDE.md, the no-attempts + parseFailed sentinel
 * path, the soft-delete skip, and the provider-targeted failed-
 * attempt enqueue rule.
 */

function attempt(overrides: Partial<LinguisticAttempt>): LinguisticAttempt {
  return {
    provider: 'bedrock',
    promptVersion: 1,
    promptHash: 'h',
    resultHash: 'r',
    success: true,
    ts: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function candidate(overrides: Partial<ReprocessCandidate>): ReprocessCandidate {
  return {
    id: 'rec-1',
    linguisticAttempts: [],
    deletedAt: null,
    parseFailed: false,
    ...overrides,
  };
}

describe('shouldReprocess — never re-run successful recordings', () => {
  it('skips a Recording with any prior successful Bedrock attempt', () => {
    const c = candidate({
      linguisticAttempts: [attempt({ success: true, promptVersion: 1 })],
      parseFailed: true, // even if the sentinel is somehow stale
    });
    expect(shouldReprocess(c, 2)).toBe(false);
  });

  it('skips a Recording with a successful rules attempt (different provider)', () => {
    // Any successful attempt at any version, any provider, blocks
    // reprocess — the Recording already has a published Message.
    const c = candidate({
      linguisticAttempts: [attempt({ provider: 'rules', success: true, promptHash: null })],
      parseFailed: true,
    });
    expect(shouldReprocess(c, 2)).toBe(false);
  });

  it('skips when the only matching failure is on a different provider', () => {
    // Failed rules attempt; new bedrock version bump can't help
    // (rules path isn't gated by Bedrock prompt version).
    const c = candidate({
      linguisticAttempts: [attempt({ provider: 'rules', success: false, promptHash: null })],
    });
    expect(shouldReprocess(c, 2)).toBe(false);
  });
});

describe('shouldReprocess — enqueue failed recordings', () => {
  it('enqueues a Recording with at least one failed bedrock attempt + no success', () => {
    const c = candidate({
      linguisticAttempts: [attempt({ success: false, resultHash: null })],
    });
    expect(shouldReprocess(c, 2)).toBe(true);
  });

  it('enqueues a Recording with no attempts logged when parseFailed=true', () => {
    const c = candidate({ linguisticAttempts: [], parseFailed: true });
    expect(shouldReprocess(c, 1)).toBe(true);
  });

  it('skips a Recording with no attempts AND parseFailed=false', () => {
    // Brand-new Recording that has not been processed yet — not
    // this driver's job to enqueue (the normal post-transcribe
    // path handles it).
    const c = candidate({ linguisticAttempts: [], parseFailed: false });
    expect(shouldReprocess(c, 1)).toBe(false);
  });
});

describe('shouldReprocess — soft-delete + provider override', () => {
  it('skips a soft-deleted Recording regardless of attempts state', () => {
    const c = candidate({
      deletedAt: '2026-05-01T00:00:00.000Z',
      linguisticAttempts: [attempt({ success: false })],
      parseFailed: true,
    });
    expect(shouldReprocess(c, 2)).toBe(false);
  });

  it('honours an explicit provider override', () => {
    const c = candidate({
      linguisticAttempts: [attempt({ provider: 'rules', success: false, promptHash: null })],
    });
    expect(shouldReprocess(c, 2, { provider: 'rules' })).toBe(true);
    expect(shouldReprocess(c, 2, { provider: 'bedrock' })).toBe(false);
  });
});

describe('shouldReprocess — null/undefined input safety', () => {
  it('treats null linguisticAttempts as empty', () => {
    const c = candidate({ linguisticAttempts: null, parseFailed: true });
    expect(shouldReprocess(c, 1)).toBe(true);
  });

  it('treats undefined linguisticAttempts as empty', () => {
    const c = candidate({ linguisticAttempts: undefined, parseFailed: true });
    expect(shouldReprocess(c, 1)).toBe(true);
  });
});

describe('selectForReprocess', () => {
  it('filters a mixed batch to only the failed-bedrock candidates', () => {
    const success = candidate({
      id: 'success',
      linguisticAttempts: [attempt({ success: true })],
    });
    const failed = candidate({
      id: 'failed',
      linguisticAttempts: [attempt({ success: false, resultHash: null })],
    });
    const fresh = candidate({ id: 'fresh', linguisticAttempts: [], parseFailed: false });
    const deleted = candidate({
      id: 'deleted',
      deletedAt: '2026-01-01T00:00:00.000Z',
      linguisticAttempts: [attempt({ success: false })],
    });
    const out = selectForReprocess([success, failed, fresh, deleted], 2);
    expect(out.map((c) => c.id)).toEqual(['failed']);
  });

  it('respects the limit cap (driver-side batching)', () => {
    const failed = (id: string) =>
      candidate({
        id,
        linguisticAttempts: [attempt({ success: false, resultHash: null })],
      });
    const batch = [failed('a'), failed('b'), failed('c'), failed('d')];
    const out = selectForReprocess(batch, 2, { limit: 2 });
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array on an empty input batch', () => {
    expect(selectForReprocess([], 2)).toEqual([]);
  });
});

describe('buildReprocessMessage', () => {
  it('produces the SQS body shape with injected ts', () => {
    const msg = buildReprocessMessage('rec-42', ReprocessReason.PROMPT_VERSION_BUMP, 7, {
      now: () => new Date('2026-05-23T12:00:00.000Z'),
    });
    expect(msg).toEqual({
      recordingId: 'rec-42',
      reason: 'prompt-version-bump',
      promptVersion: 7,
      enqueuedAt: '2026-05-23T12:00:00.000Z',
    });
  });

  it('supports the MANUAL_RETRIGGER reason for admin-triggered re-runs', () => {
    const msg = buildReprocessMessage('rec-7', ReprocessReason.MANUAL_RETRIGGER, 3, {
      now: () => new Date('2026-05-23T00:00:00.000Z'),
    });
    expect(msg.reason).toBe('manual-retrigger');
    expect(msg.promptVersion).toBe(3);
  });
});
