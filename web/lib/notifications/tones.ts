/**
 * Canned alert tones per message type (#131).
 *
 * ARCHITECTURE DEVIATION from the issue's "ship 8 binary .opus assets" plan:
 * instead of hosting/precaching 8 audio files, we SYNTHESIZE each tone at
 * runtime with the Web Audio API (OscillatorNode + GainNode). Rationale:
 *   - zero binary assets to host, version, or service-worker-precache
 *   - static-export-safe (no /public/tones bundle, no fetch at play time)
 *   - tiny: the whole tone library is a data table below
 *   - each tone is a deterministic, distinct pitch/rhythm signature per type
 * The service-worker-triggered playback path (the issue's `sw.js` /
 * `notificationclick` sketch) is OUT OF SCOPE here and lives in #129
 * (service worker + push subscription + VAPID). This module provides the
 * tone library + a user-gesture preview; #129 wires SW/foreground playback.
 *
 * Autoplay policy: nothing plays on load. `playTone` must be called from a
 * user gesture (the settings preview button) or an explicit caller; we never
 * autoplay a recording (CLAUDE.md: "canned tones per message type, no
 * recording autoplay").
 */
import { MESSAGE_TYPES, type MessageType } from '@/lib/messages/filters';

/** A single scheduled note in a tone sequence. */
export interface ToneStep {
  /** Oscillator frequency in Hz. */
  freq: number;
  /** Step duration in milliseconds. */
  durationMs: number;
}

/** A tone = an ordered, non-empty sequence of steps played back-to-back. */
export interface ToneSpec {
  steps: ToneStep[];
  /** Oscillator waveform; defaults applied at schedule time. */
  type?: OscillatorType;
}

/** Hard upper bound on a tone's total duration (ms). Keeps previews snappy. */
export const MAX_TONE_DURATION_MS = 1500;

/**
 * Per-type tone signatures.
 *
 * Design intent (distinct + priority-weighted):
 *   - SKYKING     — urgent rising 3-note klaxon, bright, top priority.
 *   - ALLSTATIONS — insistent repeated high beep (broadcast-to-all), grabby.
 *   - SKYMASTER   — authoritative descending pair, mid-high.
 *   - SKYBIRD     — deliberately UNLIKE SKYKING: low rising sweep (the issue
 *                   calls out SKYKING/SKYBIRD must be distinguishable).
 *   - DISREGARDED — short flat low double-blip, "stand down" feel.
 *   - RADIOCHECK  — soft single mid blip (routine, non-urgent).
 *   - BACKEND     — soft low single blip (admin announcement, least urgent).
 *   - OTHER       — neutral two-step mid chime.
 */
export const TONE_SPECS: Record<MessageType, ToneSpec> = {
  SKYKING: {
    type: 'square',
    steps: [
      { freq: 660, durationMs: 140 },
      { freq: 880, durationMs: 140 },
      { freq: 1175, durationMs: 220 },
    ],
  },
  ALLSTATIONS: {
    type: 'square',
    steps: [
      { freq: 1046, durationMs: 120 },
      { freq: 0, durationMs: 60 },
      { freq: 1046, durationMs: 120 },
      { freq: 0, durationMs: 60 },
      { freq: 1046, durationMs: 160 },
    ],
  },
  SKYMASTER: {
    type: 'sawtooth',
    steps: [
      { freq: 988, durationMs: 180 },
      { freq: 740, durationMs: 240 },
    ],
  },
  SKYBIRD: {
    type: 'triangle',
    steps: [
      { freq: 330, durationMs: 180 },
      { freq: 440, durationMs: 180 },
      { freq: 554, durationMs: 200 },
    ],
  },
  DISREGARDED: {
    type: 'sine',
    steps: [
      { freq: 392, durationMs: 110 },
      { freq: 0, durationMs: 50 },
      { freq: 392, durationMs: 110 },
    ],
  },
  RADIOCHECK: {
    type: 'sine',
    steps: [{ freq: 587, durationMs: 200 }],
  },
  BACKEND: {
    type: 'sine',
    steps: [{ freq: 440, durationMs: 220 }],
  },
  OTHER: {
    type: 'sine',
    steps: [
      { freq: 523, durationMs: 150 },
      { freq: 659, durationMs: 180 },
    ],
  },
};

/** Sum of all step durations for a spec, in milliseconds. */
export function toneDurationMs(spec: ToneSpec): number {
  return spec.steps.reduce((acc, s) => acc + s.durationMs, 0);
}

/**
 * A scheduled node returned by {@link scheduleSteps}. The oscillator is
 * already `start()`ed and `stop()`-scheduled; callers may keep references
 * for teardown but normally don't need to.
 */
export interface ScheduledNode {
  oscillator: OscillatorNode;
  gain: GainNode;
}

/** Result of scheduling a tone: the nodes plus the context-time it ends at. */
export interface ScheduleResult {
  nodes: ScheduledNode[];
  /** AudioContext time (seconds) at which the last step finishes. */
  endTime: number;
}

const MS = 1000;
/** Short fade applied per step to avoid click/pop artifacts (seconds). */
const RAMP_S = 0.005;
/** Peak gain per note — kept modest so previews aren't jarring. */
const PEAK_GAIN = 0.18;

/**
 * Schedule a tone spec onto an AudioContext starting at `startAt` (defaults
 * to `ctx.currentTime`). One oscillator + gain node per audible step; silent
 * steps (`freq <= 0`) advance the clock without scheduling a node so rests
 * work. Returns the scheduled nodes and the final end time.
 *
 * Pure-ish: deterministic given (spec, ctx clock). No DOM, no autoplay — the
 * caller decides when this runs.
 */
export function scheduleSteps(ctx: AudioContext, spec: ToneSpec, startAt?: number): ScheduleResult {
  const waveform: OscillatorType = spec.type ?? 'sine';
  let cursor = startAt ?? ctx.currentTime;
  const nodes: ScheduledNode[] = [];

  for (const step of spec.steps) {
    const stepEnd = cursor + step.durationMs / MS;
    if (step.freq > 0) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = waveform;
      oscillator.frequency.setValueAtTime(step.freq, cursor);

      // Envelope: ramp up, hold, ramp down — clickless.
      gain.gain.setValueAtTime(0, cursor);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, cursor + RAMP_S);
      gain.gain.setValueAtTime(PEAK_GAIN, Math.max(cursor + RAMP_S, stepEnd - RAMP_S));
      gain.gain.linearRampToValueAtTime(0, stepEnd);

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(cursor);
      oscillator.stop(stepEnd);
      nodes.push({ oscillator, gain });
    }
    cursor = stepEnd;
  }

  return { nodes, endTime: cursor };
}

/** Factory that yields a fresh AudioContext; injectable for tests. */
export type AudioContextFactory = () => AudioContext;

function defaultAudioContextFactory(): AudioContext {
  const Ctor =
    (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API is not available in this environment');
  }
  return new Ctor();
}

/**
 * Play a tone spec. Must be invoked from a user gesture (preview button) to
 * satisfy browser autoplay policy — this never runs on its own.
 *
 * The AudioContext is closed once the tone finishes to free resources. The
 * factory is injectable so tests can supply a mock (jsdom has no Web Audio).
 * Returns a promise that resolves when the tone has finished playing.
 */
export async function playTone(
  spec: ToneSpec,
  ctxFactory: AudioContextFactory = defaultAudioContextFactory,
): Promise<void> {
  const ctx = ctxFactory();
  // Some browsers create the context suspended until a gesture resumes it.
  if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    await ctx.resume();
  }
  const { endTime } = scheduleSteps(ctx, spec);
  const remainingMs = Math.max(0, (endTime - ctx.currentTime) * MS);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, remainingMs);
  });
  if (typeof ctx.close === 'function') {
    await ctx.close();
  }
}

/** Convenience: play the canonical tone for a message type. */
export async function playToneForType(
  type: MessageType,
  ctxFactory?: AudioContextFactory,
): Promise<void> {
  return playTone(TONE_SPECS[type], ctxFactory);
}

/** Re-export the canonical type list for callers iterating tones. */
export { MESSAGE_TYPES };
