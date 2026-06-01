import { describe, it, expect } from 'vitest';
import {
  COMPARISON_ROWS,
  SUBSCRIPTION_TIERS,
  getTier,
  tierMonthlyCharge,
  type TierId,
} from './tiers';

describe('SUBSCRIPTION_TIERS', () => {
  it('defines exactly three tiers at $3 / $7 / $15', () => {
    expect(SUBSCRIPTION_TIERS).toHaveLength(3);
    expect(SUBSCRIPTION_TIERS.map((t) => t.priceMonthly)).toEqual([3, 7, 15]);
    expect(SUBSCRIPTION_TIERS.map((t) => t.id)).toEqual(['tier1', 'tier2', 'tier3']);
  });

  it('every tier has a non-empty name, tagline, and features', () => {
    for (const t of SUBSCRIPTION_TIERS) {
      expect(t.name).toBeTruthy();
      expect(t.tagline).toBeTruthy();
      expect(t.features.length).toBeGreaterThan(0);
    }
  });

  it('carries the CLAUDE.md feature bullets', () => {
    const t1 = getTier('tier1')!;
    expect(t1.features).toContain('Historical access to 180 days');
    const t2 = getTier('tier2')!;
    expect(t2.features).toContain('Bulk recording download (capped)');
    expect(t2.features).toContain('Advanced filters');
    const t3 = getTier('tier3')!;
    expect(t3.features).toContain('Discord webhook relays');
    expect(t3.features).toContain('Full historical access');
  });
});

describe('getTier', () => {
  it('resolves known ids and returns undefined otherwise', () => {
    expect(getTier('tier2')?.priceMonthly).toBe(7);
    expect(getTier('nope' as TierId)).toBeUndefined();
  });
});

describe('tierMonthlyCharge', () => {
  it('returns the base price when fee is not covered', () => {
    expect(tierMonthlyCharge(getTier('tier1')!, false)).toBe(3);
  });

  it('returns the covered price when fee is covered', () => {
    // (3 + 0.30)/0.971 = 3.398 → 3.40
    expect(tierMonthlyCharge(getTier('tier1')!, true)).toBe(3.4);
  });
});

describe('COMPARISON_ROWS', () => {
  it('marks each tier inclusion consistently with feature escalation', () => {
    const bulk = COMPARISON_ROWS.find((r) => r.label.startsWith('Bulk'))!;
    expect(bulk.tiers).toEqual({ tier1: false, tier2: true, tier3: true });
    const discord = COMPARISON_ROWS.find((r) => r.label.startsWith('Discord'))!;
    expect(discord.tiers).toEqual({ tier1: false, tier2: false, tier3: true });
  });

  it('every row covers all three tiers', () => {
    for (const row of COMPARISON_ROWS) {
      expect(Object.keys(row.tiers).sort()).toEqual(['tier1', 'tier2', 'tier3']);
    }
  });
});
