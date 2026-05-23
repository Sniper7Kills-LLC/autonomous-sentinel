import { describe, it, expect, vi } from 'vitest';
import {
  CONCURRENCY_KEYS,
  DEFAULT_CONCURRENCY,
  MAX_RESERVED_CONCURRENCY,
  getConcurrencyCap,
  readConcurrencyConfig,
  type ConcurrencyKey,
} from './lambda-concurrency';

/**
 * Behaviour tests for the Lambda reserved-concurrency cap helper
 * (#68). Pins env-override resolution, default fallback on
 * invalid input, max-cap safety net, and the
 * readConcurrencyConfig roll-up.
 */

describe('CONCURRENCY_KEYS + DEFAULT_CONCURRENCY', () => {
  it('declares a default for every key (no holes)', () => {
    for (const key of CONCURRENCY_KEYS) {
      expect(typeof DEFAULT_CONCURRENCY[key]).toBe('number');
      expect(DEFAULT_CONCURRENCY[key]).toBeGreaterThan(0);
    }
  });

  it('LINGUISTIC_REPROCESS has the smallest cap (CLAUDE.md "backfill must not starve live")', () => {
    const reprocess = DEFAULT_CONCURRENCY.LINGUISTIC_REPROCESS;
    for (const key of CONCURRENCY_KEYS) {
      if (key === 'LINGUISTIC_REPROCESS') continue;
      expect(DEFAULT_CONCURRENCY[key]).toBeGreaterThanOrEqual(reprocess);
    }
  });

  it('every default is at or below the MAX_RESERVED_CONCURRENCY safety net', () => {
    for (const key of CONCURRENCY_KEYS) {
      expect(DEFAULT_CONCURRENCY[key]).toBeLessThanOrEqual(MAX_RESERVED_CONCURRENCY);
    }
  });
});

describe('getConcurrencyCap', () => {
  it('returns the built-in default when env var is unset', () => {
    expect(getConcurrencyCap('PREPROCESS', { env: {} })).toBe(DEFAULT_CONCURRENCY.PREPROCESS);
  });

  it('honours a valid integer env override', () => {
    expect(
      getConcurrencyCap('TRANSCRIBE_OPENAI', { env: { CONCURRENCY_TRANSCRIBE_OPENAI: '7' } }),
    ).toBe(7);
  });

  it('treats empty string as unset (falls back to default, no warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getConcurrencyCap('PREPROCESS', { env: { CONCURRENCY_PREPROCESS: '' } })).toBe(
      DEFAULT_CONCURRENCY.PREPROCESS,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to default with a warn on a non-integer value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getConcurrencyCap('LINGUISTIC', { env: { CONCURRENCY_LINGUISTIC: '7.5' } })).toBe(
      DEFAULT_CONCURRENCY.LINGUISTIC,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to default with a warn on zero / negative', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getConcurrencyCap('LINGUISTIC', { env: { CONCURRENCY_LINGUISTIC: '0' } })).toBe(
      DEFAULT_CONCURRENCY.LINGUISTIC,
    );
    expect(getConcurrencyCap('LINGUISTIC', { env: { CONCURRENCY_LINGUISTIC: '-3' } })).toBe(
      DEFAULT_CONCURRENCY.LINGUISTIC,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('falls back to default with a warn on values above MAX_RESERVED_CONCURRENCY (fat-finger safety)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      getConcurrencyCap('TRANSCRIBE_OPENAI', {
        env: { CONCURRENCY_TRANSCRIBE_OPENAI: String(MAX_RESERVED_CONCURRENCY + 1) },
      }),
    ).toBe(DEFAULT_CONCURRENCY.TRANSCRIBE_OPENAI);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accepts a value exactly at MAX_RESERVED_CONCURRENCY', () => {
    expect(
      getConcurrencyCap('TRANSCRIBE_AMAZON', {
        env: { CONCURRENCY_TRANSCRIBE_AMAZON: String(MAX_RESERVED_CONCURRENCY) },
      }),
    ).toBe(MAX_RESERVED_CONCURRENCY);
  });

  it('falls back to default with a warn on garbage strings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getConcurrencyCap('LINGUISTIC', { env: { CONCURRENCY_LINGUISTIC: 'banana' } })).toBe(
      DEFAULT_CONCURRENCY.LINGUISTIC,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('readConcurrencyConfig', () => {
  it('rolls up every key in one pass with applied overrides', () => {
    const config = readConcurrencyConfig({
      env: {
        CONCURRENCY_PREPROCESS: '40',
        CONCURRENCY_TRANSCRIBE_OPENAI: '5',
      },
    });
    expect(config.PREPROCESS).toBe(40);
    expect(config.TRANSCRIBE_OPENAI).toBe(5);
    expect(config.LINGUISTIC_REPROCESS).toBe(DEFAULT_CONCURRENCY.LINGUISTIC_REPROCESS);
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = readConcurrencyConfig({ env: {} });
    const b = readConcurrencyConfig({ env: {} });
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('does not mutate the DEFAULT_CONCURRENCY constant', () => {
    const snapshot = { ...DEFAULT_CONCURRENCY };
    readConcurrencyConfig({ env: { CONCURRENCY_PREPROCESS: '99' } });
    expect(DEFAULT_CONCURRENCY).toEqual(snapshot);
  });

  it('returns a value for every key in CONCURRENCY_KEYS', () => {
    const config = readConcurrencyConfig({ env: {} });
    for (const key of CONCURRENCY_KEYS as readonly ConcurrencyKey[]) {
      expect(config[key]).toBe(DEFAULT_CONCURRENCY[key]);
    }
  });
});
