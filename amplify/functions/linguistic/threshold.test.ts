import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  isFlagged,
  isValidThresholdValue,
  resolveThreshold,
  type ConfidenceConfig,
} from './threshold';

/**
 * Behaviour tests for the confidence-threshold gate (#65).
 *
 * Pins the resolution order (per-type → DEFAULT → 0.8), the `≥`
 * boundary semantic (confidence == threshold → clean), and the
 * validator used by the deferred admin mutation to reject out-of-
 * range writes.
 */

const cfg = (thresholds: Record<string, number>): ConfidenceConfig => ({
  confidenceThresholds: thresholds,
});

describe('resolveThreshold', () => {
  it('uses the per-type override when present', () => {
    expect(resolveThreshold('SKYKING', cfg({ SKYKING: 0.95, DEFAULT: 0.5 }))).toBe(0.95);
  });

  it('falls back to DEFAULT when the per-type entry is missing', () => {
    expect(resolveThreshold('SKYKING', cfg({ DEFAULT: 0.7 }))).toBe(0.7);
  });

  it('falls back to hard-coded 0.8 when neither per-type nor DEFAULT is set', () => {
    expect(resolveThreshold('SKYKING', cfg({}))).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it('treats an empty / missing config map as fully unset (hard-coded fallback)', () => {
    expect(
      resolveThreshold('SKYKING', {
        confidenceThresholds: undefined as unknown as Record<string, number>,
      }),
    ).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it('ignores an out-of-range per-type entry and falls through to DEFAULT', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveThreshold('SKYKING', cfg({ SKYKING: 1.5, DEFAULT: 0.6 }))).toBe(0.6);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('ignores an out-of-range DEFAULT and falls through to hard-coded 0.8', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveThreshold('SKYKING', cfg({ DEFAULT: -0.5 }))).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('treats a NaN per-type entry as missing', () => {
    expect(resolveThreshold('SKYKING', cfg({ SKYKING: Number.NaN, DEFAULT: 0.65 }))).toBe(0.65);
  });
});

describe('isFlagged', () => {
  it('returns false when confidence equals threshold (≥ semantic)', () => {
    expect(isFlagged({ type: 'SKYKING', confidence: 0.8 }, cfg({}))).toBe(false);
  });

  it('returns false when confidence exceeds threshold', () => {
    expect(isFlagged({ type: 'SKYKING', confidence: 0.91 }, cfg({ SKYKING: 0.9 }))).toBe(false);
  });

  it('returns true when confidence falls below threshold', () => {
    expect(isFlagged({ type: 'SKYKING', confidence: 0.79 }, cfg({}))).toBe(true);
  });

  it('uses the per-type threshold when set', () => {
    // SKYKING-specific 0.95 — 0.9 confidence flags even though it
    // would pass the global 0.8 default.
    expect(isFlagged({ type: 'SKYKING', confidence: 0.9 }, cfg({ SKYKING: 0.95 }))).toBe(true);
  });

  it('falls back to DEFAULT entry for unseen types', () => {
    expect(isFlagged({ type: 'OTHER', confidence: 0.7 }, cfg({ DEFAULT: 0.65 }))).toBe(false);
    expect(isFlagged({ type: 'OTHER', confidence: 0.6 }, cfg({ DEFAULT: 0.65 }))).toBe(true);
  });

  it('treats a non-numeric confidence as low-signal (flagged)', () => {
    expect(isFlagged({ type: 'OTHER', confidence: Number.NaN }, cfg({ DEFAULT: 0.5 }))).toBe(true);
  });
});

describe('isValidThresholdValue', () => {
  it('accepts 0, 0.5, and 1 (inclusive bounds)', () => {
    expect(isValidThresholdValue(0)).toBe(true);
    expect(isValidThresholdValue(0.5)).toBe(true);
    expect(isValidThresholdValue(1)).toBe(true);
  });

  it('rejects values below 0 and above 1', () => {
    expect(isValidThresholdValue(-0.01)).toBe(false);
    expect(isValidThresholdValue(1.01)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(isValidThresholdValue(Number.NaN)).toBe(false);
  });

  it('rejects non-number inputs (string, null, undefined, object)', () => {
    expect(isValidThresholdValue('0.5')).toBe(false);
    expect(isValidThresholdValue(null)).toBe(false);
    expect(isValidThresholdValue(undefined)).toBe(false);
    expect(isValidThresholdValue({})).toBe(false);
  });
});
