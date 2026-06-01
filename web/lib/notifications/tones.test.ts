import { describe, it, expect, vi } from 'vitest';
import { MESSAGE_TYPES } from '@/lib/messages/filters';
import {
  TONE_SPECS,
  MAX_TONE_DURATION_MS,
  toneDurationMs,
  scheduleSteps,
  playTone,
  playToneForType,
} from './tones';

/**
 * Minimal Web Audio mock — jsdom has none. Records created oscillators so we
 * can assert scheduling without real audio output.
 */
function makeMockAudioContext(opts: { state?: AudioContextState } = {}) {
  const oscillators: Array<{ startedAt?: number; stoppedAt?: number; freq?: number }> = [];
  const gains: unknown[] = [];
  let currentTime = 0;
  const ctx = {
    get currentTime() {
      return currentTime;
    },
    state: opts.state ?? 'running',
    createOscillator() {
      const node = {
        type: 'sine' as OscillatorType,
        frequency: {
          setValueAtTime: (v: number) => {
            rec.freq = v;
          },
        },
        connect: vi.fn(),
        start: (t: number) => {
          rec.startedAt = t;
        },
        stop: (t: number) => {
          rec.stoppedAt = t;
        },
      };
      const rec: { startedAt?: number; stoppedAt?: number; freq?: number } = {};
      oscillators.push(rec);
      return node as unknown as OscillatorNode;
    },
    createGain() {
      const node = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
      gains.push(node);
      return node as unknown as GainNode;
    },
    destination: {} as AudioDestinationNode,
    resume: vi.fn(() => {
      (ctx as { state: AudioContextState }).state = 'running';
      return Promise.resolve();
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  return {
    ctx: ctx as unknown as AudioContext,
    oscillators,
    gains,
    setTime: (t: number) => {
      currentTime = t;
    },
  };
}

describe('TONE_SPECS', () => {
  it('has a spec for every MessageType', () => {
    for (const type of MESSAGE_TYPES) {
      expect(TONE_SPECS[type]).toBeDefined();
    }
    // No extra keys beyond the enum.
    expect(Object.keys(TONE_SPECS).sort()).toEqual([...MESSAGE_TYPES].sort());
  });

  it('every spec is non-empty', () => {
    for (const type of MESSAGE_TYPES) {
      expect(TONE_SPECS[type].steps.length).toBeGreaterThan(0);
    }
  });

  it('every spec has positive step durations and finite frequencies', () => {
    for (const type of MESSAGE_TYPES) {
      for (const step of TONE_SPECS[type].steps) {
        expect(step.durationMs).toBeGreaterThan(0);
        expect(Number.isFinite(step.freq)).toBe(true);
        expect(step.freq).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('total duration is bounded for every type', () => {
    for (const type of MESSAGE_TYPES) {
      expect(toneDurationMs(TONE_SPECS[type])).toBeLessThanOrEqual(MAX_TONE_DURATION_MS);
    }
  });

  it('keeps SKYKING and SKYBIRD audibly distinct (different lead frequency)', () => {
    expect(TONE_SPECS.SKYKING.steps[0]?.freq).not.toEqual(TONE_SPECS.SKYBIRD.steps[0]?.freq);
  });
});

describe('toneDurationMs', () => {
  it('sums step durations', () => {
    expect(
      toneDurationMs({
        steps: [
          { freq: 100, durationMs: 50 },
          { freq: 200, durationMs: 70 },
        ],
      }),
    ).toBe(120);
  });
});

describe('scheduleSteps', () => {
  it('schedules one oscillator per audible step', () => {
    const { ctx, oscillators } = makeMockAudioContext();
    const spec = {
      steps: [
        { freq: 440, durationMs: 100 },
        { freq: 660, durationMs: 100 },
      ],
    };
    const result = scheduleSteps(ctx, spec);
    expect(result.nodes).toHaveLength(2);
    expect(oscillators).toHaveLength(2);
  });

  it('skips silent (rest) steps but still advances the clock', () => {
    const { ctx, oscillators } = makeMockAudioContext();
    const spec = {
      steps: [
        { freq: 440, durationMs: 100 },
        { freq: 0, durationMs: 50 },
        { freq: 660, durationMs: 100 },
      ],
    };
    const result = scheduleSteps(ctx, spec);
    expect(result.nodes).toHaveLength(2);
    expect(oscillators).toHaveLength(2);
    // End time accounts for the rest: (100 + 50 + 100) / 1000.
    expect(result.endTime).toBeCloseTo(0.25, 5);
  });

  it('computes endTime from the start offset', () => {
    const { ctx } = makeMockAudioContext();
    const spec = { steps: [{ freq: 440, durationMs: 200 }] };
    const result = scheduleSteps(ctx, spec, 1);
    expect(result.endTime).toBeCloseTo(1.2, 5);
  });

  it('sets each oscillator frequency from its step', () => {
    const { ctx, oscillators } = makeMockAudioContext();
    scheduleSteps(ctx, {
      steps: [
        { freq: 440, durationMs: 100 },
        { freq: 880, durationMs: 100 },
      ],
    });
    expect(oscillators.map((o) => o.freq)).toEqual([440, 880]);
  });
});

describe('playTone', () => {
  it('uses the injected factory and closes the context', async () => {
    vi.useFakeTimers();
    const mock = makeMockAudioContext();
    const factory = vi.fn(() => mock.ctx);
    const p = playTone(TONE_SPECS.OTHER, factory);
    await vi.runAllTimersAsync();
    await p;
    expect(factory).toHaveBeenCalledOnce();
    expect((mock.ctx as { close: unknown }).close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('resumes a suspended context before scheduling', async () => {
    vi.useFakeTimers();
    const mock = makeMockAudioContext({ state: 'suspended' });
    const p = playTone(TONE_SPECS.SKYKING, () => mock.ctx);
    await vi.runAllTimersAsync();
    await p;
    expect((mock.ctx as { resume: unknown }).resume).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('playToneForType resolves a spec by type', async () => {
    vi.useFakeTimers();
    const mock = makeMockAudioContext();
    const p = playToneForType('RADIOCHECK', () => mock.ctx);
    await vi.runAllTimersAsync();
    await p;
    expect(mock.oscillators).toHaveLength(TONE_SPECS.RADIOCHECK.steps.length);
    vi.useRealTimers();
  });
});
