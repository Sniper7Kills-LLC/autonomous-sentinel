import { describe, it, expect } from 'vitest';
import { DONATION_PRESETS, MAX_DONATION, MIN_DONATION, formatUsd, validateAmount } from './amount';

describe('DONATION_PRESETS', () => {
  it('matches the CLAUDE.md / #103 ladder', () => {
    expect([...DONATION_PRESETS]).toEqual([5, 10, 25, 50, 100]);
  });
});

describe('validateAmount', () => {
  it('accepts whole-dollar and cents values', () => {
    expect(validateAmount('25')).toEqual({ valid: true, amount: 25, error: null });
    expect(validateAmount('25.50')).toEqual({ valid: true, amount: 25.5, error: null });
    expect(validateAmount(10)).toEqual({ valid: true, amount: 10, error: null });
  });

  it('accepts the minimum exactly', () => {
    expect(validateAmount(MIN_DONATION).valid).toBe(true);
  });

  it('rejects empty input', () => {
    const r = validateAmount('');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/enter an amount/i);
  });

  it('rejects below the minimum', () => {
    const r = validateAmount('0.50');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/minimum/i);
  });

  it('rejects above the maximum', () => {
    const r = validateAmount(MAX_DONATION + 1);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/maximum/i);
  });

  it('rejects more than two decimal places', () => {
    expect(validateAmount('10.999').valid).toBe(false);
  });

  it('rejects non-numeric / negative / NaN', () => {
    expect(validateAmount('abc').valid).toBe(false);
    expect(validateAmount('-5').valid).toBe(false);
    expect(validateAmount(Number.NaN).valid).toBe(false);
  });
});

describe('formatUsd', () => {
  it('always shows two decimals with a dollar sign', () => {
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(10.6)).toBe('$10.60');
  });
});
