import { describe, it, expect } from 'vitest';
import {
  computeWeight,
  validateReputationConfig,
  valuesToFormValues,
  toReputationRow,
  DEFAULT_REPUTATION_CONFIG,
  DEFAULT_KEY,
  type ReputationConfigValues,
  type ReputationFormValues,
} from './reputation-config';

const cfg = DEFAULT_REPUTATION_CONFIG;

describe('computeWeight (CLAUDE.md vote-weight formula)', () => {
  it('returns the base weight for a brand-new member', () => {
    expect(
      computeWeight(cfg, { validatedSubmissions: 0, acceptedCorrections: 0, role: 'member' }),
    ).toBe(1);
  });

  it('adds the per-validated-submission bonus', () => {
    // base 1 + 0.1*3 = 1.3
    expect(
      computeWeight(cfg, { validatedSubmissions: 3, acceptedCorrections: 0, role: 'member' }),
    ).toBeCloseTo(1.3);
  });

  it('caps validated submissions at validatedCap', () => {
    // base 1 + 0.1*min(100,4) = 1.4
    expect(
      computeWeight(cfg, { validatedSubmissions: 100, acceptedCorrections: 0, role: 'member' }),
    ).toBeCloseTo(1.4);
  });

  it('caps accepted corrections at correctionCap', () => {
    // base 1 + 0.5*min(50,5) = 3.5
    expect(
      computeWeight(cfg, { validatedSubmissions: 0, acceptedCorrections: 50, role: 'member' }),
    ).toBeCloseTo(3.5);
  });

  it('adds the moderator bonus', () => {
    // base 1 + mod 1 = 2
    expect(
      computeWeight(cfg, { validatedSubmissions: 0, acceptedCorrections: 0, role: 'moderator' }),
    ).toBe(2);
  });

  it('adds the admin bonus', () => {
    // base 1 + admin 2 = 3
    expect(
      computeWeight(cfg, { validatedSubmissions: 0, acceptedCorrections: 0, role: 'admin' }),
    ).toBe(3);
  });

  it('applies the net weight cap last', () => {
    // base 1 + 0.1*4 + 0.5*5 + admin 2 = 1 + 0.4 + 2.5 + 2 = 5.9 → capped at 5
    expect(
      computeWeight(cfg, { validatedSubmissions: 4, acceptedCorrections: 5, role: 'admin' }),
    ).toBe(5);
  });

  it('clamps negative counts so weight never drops below base', () => {
    expect(
      computeWeight(cfg, { validatedSubmissions: -10, acceptedCorrections: -3, role: 'member' }),
    ).toBe(1);
  });

  it('honours custom coefficients', () => {
    const custom: ReputationConfigValues = {
      ...cfg,
      base: 2,
      perValidatedSubmission: 1,
      validatedCap: 2,
      netWeightCap: 100,
    };
    // base 2 + 1*min(10,2) = 4
    expect(
      computeWeight(custom, { validatedSubmissions: 10, acceptedCorrections: 0, role: 'member' }),
    ).toBe(4);
  });
});

describe('validateReputationConfig', () => {
  const valid = valuesToFormValues(cfg);

  it('accepts default values', () => {
    const { errors, input } = validateReputationConfig(valid);
    expect(errors).toEqual({});
    expect(input).toEqual(cfg);
  });

  it('rejects non-numeric fields', () => {
    const { errors, input } = validateReputationConfig({ ...valid, base: 'abc' });
    expect(errors.base).toBeDefined();
    expect(input).toBeNull();
  });

  it('rejects blank fields', () => {
    const { errors, input } = validateReputationConfig({ ...valid, adminBonus: '   ' });
    expect(errors.adminBonus).toBeDefined();
    expect(input).toBeNull();
  });

  it('rejects negative bonuses and caps', () => {
    const neg = validateReputationConfig({ ...valid, perValidatedSubmission: '-0.1' });
    expect(neg.errors.perValidatedSubmission).toBeDefined();
    const negCap = validateReputationConfig({ ...valid, validatedCap: '-1' });
    expect(negCap.errors.validatedCap).toBeDefined();
  });

  it('rejects non-integer caps', () => {
    const { errors } = validateReputationConfig({ ...valid, correctionCap: '5.5' });
    expect(errors.correctionCap).toBeDefined();
  });

  it('requires quorum > 0', () => {
    const { errors } = validateReputationConfig({ ...valid, quorum: '0' });
    expect(errors.quorum).toBeDefined();
  });

  it('requires confidence threshold within [0, 1]', () => {
    expect(
      validateReputationConfig({ ...valid, confidenceThreshold: '1.5' }).errors.confidenceThreshold,
    ).toBeDefined();
    expect(
      validateReputationConfig({ ...valid, confidenceThreshold: '-0.1' }).errors
        .confidenceThreshold,
    ).toBeDefined();
  });

  it('requires netWeightCap ≥ base', () => {
    const { errors } = validateReputationConfig({ ...valid, base: '6', netWeightCap: '5' });
    expect(errors.netWeightCap).toBeDefined();
  });
});

describe('toReputationRow', () => {
  it('defaults a missing/empty row to CLAUDE.md defaults', () => {
    const row = toReputationRow({});
    expect(row.key).toBe(DEFAULT_KEY);
    expect(row.base).toBe(cfg.base);
    expect(row.netWeightCap).toBe(cfg.netWeightCap);
    expect(row.notes).toBe('');
    expect(row.updatedAt).toBeNull();
  });

  it('passes through stored values', () => {
    const row = toReputationRow({
      key: DEFAULT_KEY,
      base: 2,
      adminBonus: 3,
      notes: 'tuned down',
      updatedAt: '2026-06-01T00:00:00Z',
    });
    expect(row.base).toBe(2);
    expect(row.adminBonus).toBe(3);
    expect(row.notes).toBe('tuned down');
    expect(row.updatedAt).toBe('2026-06-01T00:00:00Z');
  });
});

describe('valuesToFormValues', () => {
  it('stringifies every coefficient', () => {
    const form: ReputationFormValues = valuesToFormValues(cfg);
    expect(form.base).toBe('1');
    expect(form.perValidatedSubmission).toBe('0.1');
    expect(form.confidenceThreshold).toBe('0.8');
  });
});
