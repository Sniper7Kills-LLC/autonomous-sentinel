import { describe, it, expect } from 'vitest';
import {
  validatePlaybackConfig,
  valuesToFormValues,
  toPlaybackRow,
  DEFAULT_PLAYBACK_CONFIG,
  DEFAULT_KEY,
  TTL_MIN_SECONDS,
  TTL_MAX_SECONDS,
} from './playback-config';

const cfg = DEFAULT_PLAYBACK_CONFIG;

describe('validatePlaybackConfig', () => {
  const valid = valuesToFormValues(cfg);

  it('accepts default values', () => {
    const { errors, input } = validatePlaybackConfig(valid);
    expect(errors).toEqual({});
    expect(input).toEqual(cfg);
  });

  it('rejects non-numeric fields', () => {
    const { errors, input } = validatePlaybackConfig({ ...valid, requestsPerMinute: 'abc' });
    expect(errors.requestsPerMinute).toBeDefined();
    expect(input).toBeNull();
  });

  it('rejects blank fields', () => {
    const { errors, input } = validatePlaybackConfig({ ...valid, bytesPerHour: '   ' });
    expect(errors.bytesPerHour).toBeDefined();
    expect(input).toBeNull();
  });

  it('requires requestsPerMinute to be a positive integer', () => {
    expect(
      validatePlaybackConfig({ ...valid, requestsPerMinute: '0' }).errors.requestsPerMinute,
    ).toBeDefined();
    expect(
      validatePlaybackConfig({ ...valid, requestsPerMinute: '-5' }).errors.requestsPerMinute,
    ).toBeDefined();
    expect(
      validatePlaybackConfig({ ...valid, requestsPerMinute: '1.5' }).errors.requestsPerMinute,
    ).toBeDefined();
  });

  it('requires bytesPerHour to be greater than zero (float allowed)', () => {
    expect(
      validatePlaybackConfig({ ...valid, bytesPerHour: '0' }).errors.bytesPerHour,
    ).toBeDefined();
    expect(
      validatePlaybackConfig({ ...valid, bytesPerHour: '-1' }).errors.bytesPerHour,
    ).toBeDefined();
    // a fractional positive byte budget is allowed
    expect(
      validatePlaybackConfig({ ...valid, bytesPerHour: '12345.5' }).errors.bytesPerHour,
    ).toBeUndefined();
  });

  it('requires signedUrlTtlSeconds to be a whole number', () => {
    const { errors } = validatePlaybackConfig({ ...valid, signedUrlTtlSeconds: '300.5' });
    expect(errors.signedUrlTtlSeconds).toBeDefined();
  });

  it('clamps signedUrlTtlSeconds to [30, 3600]', () => {
    expect(
      validatePlaybackConfig({ ...valid, signedUrlTtlSeconds: String(TTL_MIN_SECONDS - 1) }).errors
        .signedUrlTtlSeconds,
    ).toBeDefined();
    expect(
      validatePlaybackConfig({ ...valid, signedUrlTtlSeconds: String(TTL_MAX_SECONDS + 1) }).errors
        .signedUrlTtlSeconds,
    ).toBeDefined();
    expect(
      validatePlaybackConfig({ ...valid, signedUrlTtlSeconds: String(TTL_MIN_SECONDS) }).errors
        .signedUrlTtlSeconds,
    ).toBeUndefined();
    expect(
      validatePlaybackConfig({ ...valid, signedUrlTtlSeconds: String(TTL_MAX_SECONDS) }).errors
        .signedUrlTtlSeconds,
    ).toBeUndefined();
  });
});

describe('toPlaybackRow', () => {
  it('defaults a missing/empty row to the playback defaults', () => {
    const row = toPlaybackRow({});
    expect(row.key).toBe(DEFAULT_KEY);
    expect(row.requestsPerMinute).toBe(cfg.requestsPerMinute);
    expect(row.bytesPerHour).toBe(cfg.bytesPerHour);
    expect(row.signedUrlTtlSeconds).toBe(cfg.signedUrlTtlSeconds);
    expect(row.notes).toBe('');
    expect(row.updatedAt).toBeNull();
  });

  it('passes through stored values', () => {
    const row = toPlaybackRow({
      key: DEFAULT_KEY,
      requestsPerMinute: 30,
      bytesPerHour: 524288000,
      signedUrlTtlSeconds: 600,
      notes: 'tightened',
      updatedAt: '2026-06-01T00:00:00Z',
    });
    expect(row.requestsPerMinute).toBe(30);
    expect(row.bytesPerHour).toBe(524288000);
    expect(row.signedUrlTtlSeconds).toBe(600);
    expect(row.notes).toBe('tightened');
    expect(row.updatedAt).toBe('2026-06-01T00:00:00Z');
  });
});

describe('valuesToFormValues', () => {
  it('stringifies every knob', () => {
    const form = valuesToFormValues(cfg);
    expect(form.requestsPerMinute).toBe('60');
    expect(form.bytesPerHour).toBe('1073741824');
    expect(form.signedUrlTtlSeconds).toBe('300');
  });
});
