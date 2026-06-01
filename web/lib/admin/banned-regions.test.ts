import { describe, it, expect } from 'vitest';
import {
  validateCountryCode,
  validateBannedRegionInput,
  rowToFormValues,
  toBannedRegionRow,
  type BannedRegionFormValues,
} from './banned-regions';

const base: BannedRegionFormValues = {
  countryCode: 'us',
  title: 'Service unavailable',
  bodyMarkdown: '# Blocked\n\nThis service is **unavailable** in your region.',
  enabled: true,
};

describe('validateCountryCode', () => {
  it('accepts and upper-cases two-letter codes', () => {
    expect(validateCountryCode('us')).toBe('US');
    expect(validateCountryCode('GB')).toBe('GB');
    expect(validateCountryCode('  de  ')).toBe('DE');
  });

  it('rejects non-two-letter input', () => {
    expect(validateCountryCode('')).toBeNull();
    expect(validateCountryCode('U')).toBeNull();
    expect(validateCountryCode('USA')).toBeNull();
    expect(validateCountryCode('U1')).toBeNull();
    expect(validateCountryCode('12')).toBeNull();
    expect(validateCountryCode('u.s')).toBeNull();
  });
});

describe('validateBannedRegionInput', () => {
  it('accepts valid input and produces a cleaned payload', () => {
    const { errors, input } = validateBannedRegionInput(base);
    expect(errors).toEqual({});
    expect(input).toEqual({
      countryCode: 'US', // upper-cased
      title: 'Service unavailable',
      bodyMarkdown: '# Blocked\n\nThis service is **unavailable** in your region.',
      enabled: true,
    });
  });

  it('requires a country code', () => {
    const { errors, input } = validateBannedRegionInput({ ...base, countryCode: '   ' });
    expect(errors.countryCode).toBeDefined();
    expect(input).toBeNull();
  });

  it('rejects a malformed country code', () => {
    const { errors, input } = validateBannedRegionInput({ ...base, countryCode: 'USA' });
    expect(errors.countryCode).toBeDefined();
    expect(input).toBeNull();
  });

  it('requires a non-blank title', () => {
    const { errors, input } = validateBannedRegionInput({ ...base, title: '  ' });
    expect(errors.title).toBeDefined();
    expect(input).toBeNull();
  });

  it('requires non-blank body markdown', () => {
    const { errors, input } = validateBannedRegionInput({ ...base, bodyMarkdown: '   ' });
    expect(errors.bodyMarkdown).toBeDefined();
    expect(input).toBeNull();
  });

  it('passes the enabled flag through', () => {
    expect(validateBannedRegionInput({ ...base, enabled: false }).input?.enabled).toBe(false);
    expect(validateBannedRegionInput(base).input?.enabled).toBe(true);
  });
});

describe('toBannedRegionRow', () => {
  it('normalizes nullish fields; defaults enabled true', () => {
    const row = toBannedRegionRow({
      countryCode: 'US',
      title: null,
      bodyMarkdown: null,
      enabled: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null,
    });
    expect(row).toEqual({
      countryCode: 'US',
      title: '',
      bodyMarkdown: '',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null,
    });
  });

  it('treats explicit false as disabled', () => {
    expect(toBannedRegionRow({ countryCode: 'US', enabled: false }).enabled).toBe(false);
  });
});

describe('rowToFormValues', () => {
  it('round-trips a row back into editable form values', () => {
    const values = rowToFormValues({
      countryCode: 'GB',
      title: 'Blocked',
      bodyMarkdown: 'Body',
      enabled: false,
      createdAt: null,
      updatedAt: null,
    });
    expect(values).toEqual({
      countryCode: 'GB',
      title: 'Blocked',
      bodyMarkdown: 'Body',
      enabled: false,
    });
  });
});
