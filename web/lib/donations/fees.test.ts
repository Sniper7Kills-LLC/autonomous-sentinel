import { describe, it, expect } from 'vitest';
import {
  STRIPE_FIXED_FEE,
  STRIPE_PERCENT_FEE,
  chargedAmount,
  coveredAmount,
  feeUplift,
  roundUpCents,
} from './fees';

describe('roundUpCents', () => {
  it('rounds up to the next whole cent', () => {
    expect(roundUpCents(1.001)).toBe(1.01);
    expect(roundUpCents(1.0)).toBe(1.0);
    expect(roundUpCents(10.555)).toBe(10.56);
  });

  it('absorbs binary-float noise (no spurious round-up)', () => {
    // 5.15 in float is 5.1500000000000004 — must not become 5.16
    expect(roundUpCents(5.15)).toBe(5.15);
  });
});

describe('coveredAmount', () => {
  it('grosses up so the project nets the intended amount', () => {
    // (10 + 0.30) / (1 - 0.029) = 10.6076... → 10.61
    expect(coveredAmount(10)).toBe(10.61);
  });

  it('matches the documented formula across the preset ladder', () => {
    const expected: Record<number, number> = {
      5: 5.46, // (5.30)/0.971 = 5.4583 → 5.46
      10: 10.61,
      25: 26.06, // (25.30)/0.971 = 26.055 → 26.06
      50: 51.81, // (50.30)/0.971 = 51.800 → 51.81 (51.8001)
      100: 103.3, // (100.30)/0.971 = 103.295 → 103.30
    };
    for (const [intended, total] of Object.entries(expected)) {
      expect(coveredAmount(Number(intended))).toBe(total);
    }
  });

  it('the net after Stripe fee is at least the intended amount', () => {
    for (const intended of [1, 3, 5, 7, 10, 15, 25, 50, 100, 137.42]) {
      const covered = coveredAmount(intended);
      const net = covered - (covered * STRIPE_PERCENT_FEE + STRIPE_FIXED_FEE);
      expect(net).toBeGreaterThanOrEqual(intended - 1e-9);
    }
  });

  it('returns 0 / passthrough for non-positive or invalid input', () => {
    expect(coveredAmount(0)).toBe(0);
    expect(coveredAmount(-5)).toBe(0);
    expect(coveredAmount(Number.NaN)).toBe(0);
  });
});

describe('feeUplift', () => {
  it('is the difference between covered and intended', () => {
    expect(feeUplift(10)).toBe(0.61);
    expect(feeUplift(100)).toBe(3.3);
  });

  it('is zero for non-positive input', () => {
    expect(feeUplift(0)).toBe(0);
    expect(feeUplift(-1)).toBe(0);
  });
});

describe('chargedAmount', () => {
  it('returns the covered amount when fee is covered', () => {
    expect(chargedAmount(10, true)).toBe(10.61);
  });

  it('returns the intended amount (cent-rounded) when not covered', () => {
    expect(chargedAmount(10, false)).toBe(10);
    expect(chargedAmount(10.005, false)).toBe(10.01);
  });

  it('exposes the published fee constants', () => {
    expect(STRIPE_PERCENT_FEE).toBe(0.029);
    expect(STRIPE_FIXED_FEE).toBe(0.3);
  });
});
