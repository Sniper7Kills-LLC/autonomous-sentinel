import { describe, it, expect } from 'vitest';
import {
  validateBudgetConfig,
  valuesToFormValues,
  toBudgetRow,
  DEFAULT_BUDGET_CONFIG,
  DEFAULT_KEY,
  type BudgetFormValues,
} from './budget-config';

const cfg = { ...DEFAULT_BUDGET_CONFIG, notificationEmail: 'ops@example.com' };
const valid: BudgetFormValues = valuesToFormValues(cfg);

describe('validateBudgetConfig', () => {
  it('accepts default values with a valid email', () => {
    const { errors, input } = validateBudgetConfig(valid);
    expect(errors).toEqual({});
    expect(input).toEqual(cfg);
  });

  it('rejects non-numeric thresholds', () => {
    const { errors, input } = validateBudgetConfig({ ...valid, softUsd: 'abc' });
    expect(errors.softUsd).toBeDefined();
    expect(input).toBeNull();
  });

  it('rejects blank thresholds', () => {
    const { errors, input } = validateBudgetConfig({ ...valid, loudUsd: '   ' });
    expect(errors.loudUsd).toBeDefined();
    expect(input).toBeNull();
  });

  it('rejects non-integer thresholds', () => {
    const { errors } = validateBudgetConfig({ ...valid, hardUsd: '200.5' });
    expect(errors.hardUsd).toBeDefined();
  });

  it('rejects non-positive thresholds', () => {
    expect(validateBudgetConfig({ ...valid, softUsd: '0' }).errors.softUsd).toBeDefined();
    expect(validateBudgetConfig({ ...valid, softUsd: '-5' }).errors.softUsd).toBeDefined();
  });

  it('enforces soft < loud', () => {
    const { errors, input } = validateBudgetConfig({ ...valid, softUsd: '100', loudUsd: '100' });
    expect(errors.loudUsd).toBeDefined();
    expect(input).toBeNull();
  });

  it('enforces loud < hard', () => {
    const { errors, input } = validateBudgetConfig({ ...valid, loudUsd: '200', hardUsd: '200' });
    expect(errors.hardUsd).toBeDefined();
    expect(input).toBeNull();
  });

  it('enforces the full soft < loud < hard ordering', () => {
    const { errors } = validateBudgetConfig({
      ...valid,
      softUsd: '300',
      loudUsd: '200',
      hardUsd: '100',
    });
    expect(errors.loudUsd ?? errors.hardUsd).toBeDefined();
  });

  it('rejects an invalid email', () => {
    expect(
      validateBudgetConfig({ ...valid, notificationEmail: 'nope' }).errors.notificationEmail,
    ).toBeDefined();
    expect(
      validateBudgetConfig({ ...valid, notificationEmail: '' }).errors.notificationEmail,
    ).toBeDefined();
  });

  it('passes the action toggles through unchanged', () => {
    const { input } = validateBudgetConfig({
      ...valid,
      softBannerEnabled: true,
      loudBannerEnabled: false,
      hardThrottleEnabled: false,
      hardPageEnabled: true,
    });
    expect(input).toMatchObject({
      softBannerEnabled: true,
      loudBannerEnabled: false,
      hardThrottleEnabled: false,
      hardPageEnabled: true,
    });
  });
});

describe('toBudgetRow', () => {
  it('defaults a missing/empty row to CLAUDE.md defaults', () => {
    const row = toBudgetRow({});
    expect(row.key).toBe(DEFAULT_KEY);
    expect(row.softUsd).toBe(50);
    expect(row.loudUsd).toBe(100);
    expect(row.hardUsd).toBe(200);
    expect(row.loudBannerEnabled).toBe(true);
    expect(row.hardThrottleEnabled).toBe(true);
    expect(row.notes).toBe('');
    expect(row.updatedAt).toBeNull();
  });

  it('passes through stored values, including a false toggle', () => {
    const row = toBudgetRow({
      key: DEFAULT_KEY,
      softUsd: 25,
      hardUsd: 500,
      notificationEmail: 'ops@example.com',
      hardThrottleEnabled: false,
      notes: 'tuned for dev',
      updatedAt: '2026-06-01T00:00:00Z',
    });
    expect(row.softUsd).toBe(25);
    expect(row.hardUsd).toBe(500);
    expect(row.notificationEmail).toBe('ops@example.com');
    expect(row.hardThrottleEnabled).toBe(false);
    expect(row.notes).toBe('tuned for dev');
    expect(row.updatedAt).toBe('2026-06-01T00:00:00Z');
  });
});

describe('valuesToFormValues', () => {
  it('stringifies thresholds and keeps actions as booleans', () => {
    const form = valuesToFormValues(cfg);
    expect(form.softUsd).toBe('50');
    expect(form.loudUsd).toBe('100');
    expect(form.hardUsd).toBe('200');
    expect(form.notificationEmail).toBe('ops@example.com');
    expect(form.loudBannerEnabled).toBe(true);
  });
});
