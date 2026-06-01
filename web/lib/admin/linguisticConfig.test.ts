import { describe, it, expect } from 'vitest';
import { MESSAGE_TYPES } from '@/lib/messages/filters';
import {
  clampThreshold,
  normalizeThresholds,
  parseSchemaJson,
  normalizeSchemas,
  formatSchemaJson,
  DEFAULT_THRESHOLD,
  THRESHOLDS_KEY,
  SCHEMAS_KEY,
} from './linguisticConfig';

describe('keys', () => {
  it('exposes the LinguisticConfig row keys', () => {
    expect(THRESHOLDS_KEY).toBe('thresholds');
    expect(SCHEMAS_KEY).toBe('schemas');
    expect(DEFAULT_THRESHOLD).toBe(0.8);
  });
});

describe('clampThreshold', () => {
  it('passes through in-range values', () => {
    expect(clampThreshold(0)).toBe(0);
    expect(clampThreshold(0.5)).toBe(0.5);
    expect(clampThreshold(1)).toBe(1);
  });

  it('clamps out-of-range values to [0,1]', () => {
    expect(clampThreshold(-0.3)).toBe(0);
    expect(clampThreshold(2.5)).toBe(1);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampThreshold(NaN)).toBe(DEFAULT_THRESHOLD);
    expect(clampThreshold(Infinity)).toBe(DEFAULT_THRESHOLD);
    expect(clampThreshold(-Infinity)).toBe(DEFAULT_THRESHOLD);
  });
});

describe('normalizeThresholds', () => {
  it('defaults every type to 0.8 when given nothing', () => {
    const out = normalizeThresholds(undefined);
    expect(Object.keys(out).sort()).toEqual([...MESSAGE_TYPES].sort());
    for (const t of MESSAGE_TYPES) expect(out[t]).toBe(DEFAULT_THRESHOLD);
  });

  it('keeps provided values and clamps them, defaulting the rest', () => {
    const out = normalizeThresholds({ SKYKING: 0.95, OTHER: 5, BACKEND: -1 });
    expect(out.SKYKING).toBe(0.95);
    expect(out.OTHER).toBe(1);
    expect(out.BACKEND).toBe(0);
    expect(out.RADIOCHECK).toBe(DEFAULT_THRESHOLD);
  });

  it('ignores unknown / stale keys and non-numeric entries', () => {
    const out = normalizeThresholds({ BOGUS: 0.4, SKYKING: 'high' });
    expect(out).not.toHaveProperty('BOGUS');
    expect(out.SKYKING).toBe(DEFAULT_THRESHOLD);
  });
});

describe('parseSchemaJson', () => {
  it('accepts an empty string as the empty schema', () => {
    expect(parseSchemaJson('   ')).toEqual({ ok: true, value: {} });
  });

  it('parses a valid JSON object', () => {
    const r = parseSchemaJson('{ "sender": { "type": "string" } }');
    expect(r).toEqual({ ok: true, value: { sender: { type: 'string' } } });
  });

  it('rejects invalid JSON with the parser error', () => {
    const r = parseSchemaJson('{ not json ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it('rejects non-object JSON (array / scalar)', () => {
    expect(parseSchemaJson('[1,2]').ok).toBe(false);
    expect(parseSchemaJson('42').ok).toBe(false);
    expect(parseSchemaJson('"x"').ok).toBe(false);
    expect(parseSchemaJson('null').ok).toBe(false);
  });
});

describe('normalizeSchemas', () => {
  it('defaults every type to an empty object', () => {
    const out = normalizeSchemas(null);
    for (const t of MESSAGE_TYPES) expect(out[t]).toEqual({});
  });

  it('keeps object entries and drops non-objects', () => {
    const out = normalizeSchemas({ SKYKING: { a: 1 }, OTHER: [1, 2], BACKEND: 'x' });
    expect(out.SKYKING).toEqual({ a: 1 });
    expect(out.OTHER).toEqual({});
    expect(out.BACKEND).toEqual({});
  });
});

describe('formatSchemaJson', () => {
  it('renders empty object as empty string', () => {
    expect(formatSchemaJson({})).toBe('');
  });

  it('pretty-prints with 2-space indent', () => {
    expect(formatSchemaJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
