import { describe, it, expect } from 'vitest';
import {
  parseVariants,
  validateCallsignInput,
  rowToFormValues,
  toCallsignRow,
  type CallsignFormValues,
} from './callsigns';

const base: CallsignFormValues = {
  normalized: 'skyking',
  variants: 'skyking, Sky King, MAINSAIL',
  source: 'ADMIN',
  approved: true,
  notes: 'primary all-stations caller',
};

describe('parseVariants', () => {
  it('parses comma-separated values, uppercased', () => {
    expect(parseVariants('skyking, mainsail, foxtrot')).toEqual(['SKYKING', 'MAINSAIL', 'FOXTROT']);
  });

  it('preserves multi-word variants (splits on comma + newline, NOT spaces)', () => {
    expect(parseVariants('SKYKING, SKY KING, MAINSAIL')).toEqual([
      'SKYKING',
      'SKY KING',
      'MAINSAIL',
    ]);
    expect(parseVariants('ANY AIRBORNE COMMAND, SKY KING')).toEqual([
      'ANY AIRBORNE COMMAND',
      'SKY KING',
    ]);
  });

  it('parses newline-separated values', () => {
    expect(parseVariants('skyking\nsky king\nmainsail')).toEqual([
      'SKYKING',
      'SKY KING',
      'MAINSAIL',
    ]);
    expect(parseVariants('skyking,, mainsail  ,foxtrot')).toEqual([
      'SKYKING',
      'MAINSAIL',
      'FOXTROT',
    ]);
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(parseVariants('SKY   KING, ANY\tAIRBORNE  COMMAND')).toEqual([
      'SKY KING',
      'ANY AIRBORNE COMMAND',
    ]);
  });

  it('dedupes case-insensitively, preserving first-seen order', () => {
    expect(parseVariants('SkyKing, SKYKING, skyking, Mainsail')).toEqual(['SKYKING', 'MAINSAIL']);
    expect(parseVariants('Sky King, SKY KING, sky  king')).toEqual(['SKY KING']);
  });

  it('drops empty tokens', () => {
    expect(parseVariants('  ,, skyking ,  ')).toEqual(['SKYKING']);
    expect(parseVariants('\n\nsky king\n\n')).toEqual(['SKY KING']);
  });

  it('returns an empty array for blank / nullish input', () => {
    expect(parseVariants('')).toEqual([]);
    expect(parseVariants('   ')).toEqual([]);
    expect(parseVariants(undefined as unknown as string)).toEqual([]);
  });
});

describe('validateCallsignInput', () => {
  it('accepts valid input and produces a cleaned payload', () => {
    const { errors, input } = validateCallsignInput(base);
    expect(errors).toEqual({});
    // Tokens split on comma + newline (NOT spaces), uppercased, deduped:
    // 'skyking, Sky King, MAINSAIL' → SKYKING, SKY KING, MAINSAIL.
    expect(input).toEqual({
      normalized: 'SKYKING', // uppercased + trimmed
      variants: ['SKYKING', 'SKY KING', 'MAINSAIL'],
      source: 'ADMIN',
      approved: true,
      notes: 'primary all-stations caller',
    });
  });

  it('requires a non-blank normalized callsign', () => {
    const { errors, input } = validateCallsignInput({ ...base, normalized: '   ' });
    expect(errors.normalized).toBeDefined();
    expect(input).toBeNull();
  });

  it('uppercases + trims the normalized value', () => {
    const { input } = validateCallsignInput({ ...base, normalized: '  mainsail  ' });
    expect(input?.normalized).toBe('MAINSAIL');
  });

  it('blanks optional notes to null', () => {
    const { input } = validateCallsignInput({ ...base, notes: '   ' });
    expect(input?.notes).toBeNull();
  });

  it('passes source + approved through', () => {
    const { input } = validateCallsignInput({
      ...base,
      source: 'AI_SUGGESTED',
      approved: false,
    });
    expect(input?.source).toBe('AI_SUGGESTED');
    expect(input?.approved).toBe(false);
  });
});

describe('toCallsignRow', () => {
  it('normalizes nullish fields and filters blank variants', () => {
    const row = toCallsignRow({
      id: 'c1',
      normalized: 'SKYKING',
      variants: ['SKY KING', null, '  ', 'SKYKING'],
      source: 'AI_SUGGESTED',
      confidence: 0.72,
      approved: false,
      notes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null,
    });
    expect(row.variants).toEqual(['SKY KING', 'SKYKING']);
    expect(row.source).toBe('AI_SUGGESTED');
    expect(row.confidence).toBe(0.72);
    expect(row.approved).toBe(false);
    expect(row.notes).toBeNull();
  });

  it('treats a missing approved value as approved (model default true)', () => {
    const row = toCallsignRow({ id: 'c2', normalized: 'X' });
    expect(row.approved).toBe(true);
    expect(row.variants).toEqual([]);
    expect(row.source).toBeNull();
  });

  it('coerces an unknown source to null', () => {
    const row = toCallsignRow({ id: 'c3', normalized: 'X', source: 'BOGUS' });
    expect(row.source).toBeNull();
  });
});

describe('rowToFormValues', () => {
  it('round-trips a row back into editable form values', () => {
    const values = rowToFormValues({
      id: 'c1',
      normalized: 'SKYKING',
      variants: ['SKY KING', 'SKYKING'],
      source: 'LEGACY',
      confidence: null,
      approved: false,
      notes: 'note',
      createdAt: null,
      updatedAt: null,
    });
    expect(values).toEqual({
      normalized: 'SKYKING',
      variants: 'SKY KING, SKYKING',
      source: 'LEGACY',
      approved: false,
      notes: 'note',
    });
  });

  it('round-trips variants through parseVariants without splitting multi-word entries', () => {
    const variants = ['SKYKING', 'SKY KING', 'ANY AIRBORNE COMMAND', 'MAINSAIL'];
    const values = rowToFormValues({
      id: 'c1',
      normalized: 'SKYKING',
      variants,
      source: 'ADMIN',
      confidence: null,
      approved: true,
      notes: null,
      createdAt: null,
      updatedAt: null,
    });
    // rowToFormValues → parseVariants must yield the original array.
    expect(parseVariants(values.variants)).toEqual(variants);
  });

  it('defaults a null source to ADMIN and renders missing notes empty', () => {
    const values = rowToFormValues({
      id: 'c1',
      normalized: 'X',
      variants: [],
      source: null,
      confidence: null,
      approved: true,
      notes: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(values.source).toBe('ADMIN');
    expect(values.notes).toBe('');
    expect(values.variants).toBe('');
  });
});
