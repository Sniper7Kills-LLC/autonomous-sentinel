import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MISMATCH_CONFIDENCE_THRESHOLD,
  EXPECTED_LANGUAGE,
  evaluateLanguage,
  normalizeLanguageCode,
} from './language';

/**
 * Behaviour tests for the English-only language-hint evaluator
 * (#60). Pins normalisation (region strip, lowercase, alias),
 * the "no detection" + English + high-confidence-non-English +
 * low-confidence-non-English paths, and the confidence boundary.
 */

describe('normalizeLanguageCode', () => {
  it('returns lowercase IETF subtag', () => {
    expect(normalizeLanguageCode('EN')).toBe('en');
    expect(normalizeLanguageCode('en')).toBe('en');
  });

  it('strips region tags', () => {
    expect(normalizeLanguageCode('en-US')).toBe('en');
    expect(normalizeLanguageCode('en_GB')).toBe('en');
    expect(normalizeLanguageCode('de-AT')).toBe('de');
  });

  it('maps spoken-name aliases to IETF codes', () => {
    expect(normalizeLanguageCode('english')).toBe('en');
    expect(normalizeLanguageCode('ENGLISH')).toBe('en');
    expect(normalizeLanguageCode('german')).toBe('de');
    expect(normalizeLanguageCode('Spanish')).toBe('es');
  });

  it('returns null on empty / null / non-string input', () => {
    expect(normalizeLanguageCode(null)).toBeNull();
    expect(normalizeLanguageCode(undefined)).toBeNull();
    expect(normalizeLanguageCode('')).toBeNull();
    expect(normalizeLanguageCode('   ')).toBeNull();
    expect(normalizeLanguageCode(42 as unknown as string)).toBeNull();
  });

  it('passes unknown codes through (no alias drop)', () => {
    expect(normalizeLanguageCode('xx')).toBe('xx');
  });
});

describe('evaluateLanguage — English / no-detection paths', () => {
  it('accepts an English detection', () => {
    const out = evaluateLanguage({ language: 'en', confidence: 0.99 });
    expect(out).toEqual({
      accepted: true,
      flagged: false,
      normalisedCode: 'en',
      reason: 'expected-language-en',
    });
  });

  it('accepts an en-US detection via region strip', () => {
    expect(evaluateLanguage({ language: 'en-US', confidence: 0.95 }).accepted).toBe(true);
  });

  it('accepts an English Whisper-alias detection', () => {
    expect(evaluateLanguage({ language: 'english', confidence: 0.9 }).accepted).toBe(true);
  });

  it('accepts and does not flag when no language detected', () => {
    const out = evaluateLanguage({ language: null, confidence: 0.0 });
    expect(out).toEqual({
      accepted: true,
      flagged: false,
      normalisedCode: null,
      reason: 'no-detection',
    });
  });

  it('treats undefined detection input as no-detection (accept)', () => {
    expect(evaluateLanguage(null)).toEqual({
      accepted: true,
      flagged: false,
      normalisedCode: null,
      reason: 'no-detection',
    });
    expect(evaluateLanguage(undefined)).toEqual({
      accepted: true,
      flagged: false,
      normalisedCode: null,
      reason: 'no-detection',
    });
  });
});

describe('evaluateLanguage — non-English paths', () => {
  it('flags + holds when high-confidence non-English', () => {
    const out = evaluateLanguage({ language: 'de', confidence: 0.92 });
    expect(out.accepted).toBe(false);
    expect(out.flagged).toBe(true);
    expect(out.normalisedCode).toBe('de');
    expect(out.reason).toBe('non-en-de');
  });

  it('does NOT flag when non-English detected at low confidence (tolerated as noise)', () => {
    const out = evaluateLanguage({ language: 'de', confidence: 0.3 });
    expect(out.accepted).toBe(true);
    expect(out.flagged).toBe(false);
    expect(out.normalisedCode).toBe('de');
    expect(out.reason).toBe('low-confidence-de-tolerated');
  });

  it('treats confidence exactly at the threshold (0.6) as low (NOT flagged)', () => {
    // strict `>` boundary: confidence === threshold tolerates rather than flags
    const out = evaluateLanguage({
      language: 'es',
      confidence: DEFAULT_MISMATCH_CONFIDENCE_THRESHOLD,
    });
    expect(out.flagged).toBe(false);
    expect(out.accepted).toBe(true);
  });

  it('treats confidence just above the threshold as high (flagged)', () => {
    const out = evaluateLanguage({
      language: 'es',
      confidence: DEFAULT_MISMATCH_CONFIDENCE_THRESHOLD + 0.001,
    });
    expect(out.flagged).toBe(true);
    expect(out.accepted).toBe(false);
  });

  it('treats missing confidence as definitive (flags non-English)', () => {
    // whisper.cpp + Bedrock often don't surface a confidence
    // number; without one, the spec says trust the detection.
    const out = evaluateLanguage({ language: 'ja' });
    expect(out.flagged).toBe(true);
    expect(out.accepted).toBe(false);
  });

  it('treats NaN / non-finite confidence as definitive (flags non-English)', () => {
    const out = evaluateLanguage({ language: 'ru', confidence: Number.NaN });
    expect(out.flagged).toBe(true);
  });
});

describe('evaluateLanguage — option overrides', () => {
  it('honours a custom expectedLanguage (project pivot scenario)', () => {
    const out = evaluateLanguage({ language: 'fr', confidence: 0.95 }, { expectedLanguage: 'fr' });
    expect(out.accepted).toBe(true);
    expect(out.flagged).toBe(false);
    expect(out.reason).toBe('expected-language-fr');
  });

  it('honours a custom mismatch confidence threshold', () => {
    // Tight threshold: 0.4 → 0.5 counts as high-confidence non-en
    const out = evaluateLanguage(
      { language: 'de', confidence: 0.5 },
      { mismatchConfidenceThreshold: 0.4 },
    );
    expect(out.flagged).toBe(true);
  });
});

describe('evaluateLanguage — module-level constants', () => {
  it('EXPECTED_LANGUAGE is en', () => {
    expect(EXPECTED_LANGUAGE).toBe('en');
  });

  it('DEFAULT_MISMATCH_CONFIDENCE_THRESHOLD is 0.6 per #60 spec', () => {
    expect(DEFAULT_MISMATCH_CONFIDENCE_THRESHOLD).toBe(0.6);
  });
});
