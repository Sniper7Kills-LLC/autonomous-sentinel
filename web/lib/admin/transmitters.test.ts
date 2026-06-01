import { describe, it, expect } from 'vitest';
import {
  parseFrequencyList,
  validateTransmitterInput,
  rowToFormValues,
  toTransmitterRow,
  type TransmitterFormValues,
} from './transmitters';

const base: TransmitterFormValues = {
  name: 'Andrews',
  latitude: '38.81',
  longitude: '-76.87',
  callsign: 'skyking',
  frequencyKhzList: '8992, 11175',
  notes: 'primary HFGCS node',
};

describe('parseFrequencyList', () => {
  it('parses comma-separated integers', () => {
    expect(parseFrequencyList('8992, 11175, 6739')).toEqual([8992, 11175, 6739]);
  });

  it('parses whitespace / mixed separators', () => {
    expect(parseFrequencyList('8992 11175\n6739')).toEqual([8992, 11175, 6739]);
    expect(parseFrequencyList('8992,, 11175  ,6739')).toEqual([8992, 11175, 6739]);
  });

  it('drops non-integer, non-positive, and unparseable tokens', () => {
    expect(parseFrequencyList('8992, abc, 11.5, -3, 0, 6739')).toEqual([8992, 6739]);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(parseFrequencyList('8992, 11175, 8992')).toEqual([8992, 11175]);
  });

  it('returns an empty array for blank / nullish input', () => {
    expect(parseFrequencyList('')).toEqual([]);
    expect(parseFrequencyList('   ')).toEqual([]);
    expect(parseFrequencyList(undefined as unknown as string)).toEqual([]);
  });
});

describe('validateTransmitterInput', () => {
  it('accepts valid input and produces a cleaned payload', () => {
    const { errors, input } = validateTransmitterInput(base);
    expect(errors).toEqual({});
    expect(input).toEqual({
      name: 'Andrews',
      latitude: 38.81,
      longitude: -76.87,
      callsign: 'SKYKING', // uppercased
      frequencyKhzList: [8992, 11175],
      notes: 'primary HFGCS node',
    });
  });

  it('requires a non-blank name', () => {
    const { errors, input } = validateTransmitterInput({ ...base, name: '   ' });
    expect(errors.name).toBeDefined();
    expect(input).toBeNull();
  });

  it('rejects latitude out of the −90..90 range', () => {
    expect(validateTransmitterInput({ ...base, latitude: '91' }).errors.latitude).toBeDefined();
    expect(validateTransmitterInput({ ...base, latitude: '-91' }).errors.latitude).toBeDefined();
    expect(validateTransmitterInput({ ...base, latitude: '90' }).errors.latitude).toBeUndefined();
    expect(validateTransmitterInput({ ...base, latitude: '-90' }).errors.latitude).toBeUndefined();
  });

  it('rejects longitude out of the −180..180 range', () => {
    expect(validateTransmitterInput({ ...base, longitude: '181' }).errors.longitude).toBeDefined();
    expect(validateTransmitterInput({ ...base, longitude: '-181' }).errors.longitude).toBeDefined();
    expect(
      validateTransmitterInput({ ...base, longitude: '180' }).errors.longitude,
    ).toBeUndefined();
  });

  it('requires numeric, non-blank coordinates', () => {
    const blank = validateTransmitterInput({ ...base, latitude: '', longitude: '' });
    expect(blank.errors.latitude).toBeDefined();
    expect(blank.errors.longitude).toBeDefined();

    const nan = validateTransmitterInput({ ...base, latitude: 'north', longitude: 'west' });
    expect(nan.errors.latitude).toBeDefined();
    expect(nan.errors.longitude).toBeDefined();
  });

  it('flags malformed frequency tokens', () => {
    expect(
      validateTransmitterInput({ ...base, frequencyKhzList: '8992, abc' }).errors.frequencyKhzList,
    ).toBeDefined();
    expect(
      validateTransmitterInput({ ...base, frequencyKhzList: '8992, -3' }).errors.frequencyKhzList,
    ).toBeDefined();
    // Blank list is allowed.
    expect(
      validateTransmitterInput({ ...base, frequencyKhzList: '' }).errors.frequencyKhzList,
    ).toBeUndefined();
  });

  it('blanks optional callsign / notes to null', () => {
    const { input } = validateTransmitterInput({ ...base, callsign: '  ', notes: '  ' });
    expect(input?.callsign).toBeNull();
    expect(input?.notes).toBeNull();
  });
});

describe('toTransmitterRow', () => {
  it('normalizes nullish fields and filters non-numeric frequencies', () => {
    const row = toTransmitterRow({
      id: 't1',
      name: 'Site',
      latitude: 10,
      longitude: 20,
      callsign: null,
      frequencyKhzList: [8992, null, 11175],
      notes: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null,
    });
    expect(row.frequencyKhzList).toEqual([8992, 11175]);
    expect(row.callsign).toBeNull();
    expect(row.latitude).toBe(10);
  });
});

describe('rowToFormValues', () => {
  it('round-trips a row back into editable string form values', () => {
    const values = rowToFormValues({
      id: 't1',
      name: 'Andrews',
      latitude: 38.81,
      longitude: -76.87,
      callsign: 'SKYKING',
      frequencyKhzList: [8992, 11175],
      notes: 'note',
      createdAt: null,
      updatedAt: null,
    });
    expect(values).toEqual({
      name: 'Andrews',
      latitude: '38.81',
      longitude: '-76.87',
      callsign: 'SKYKING',
      frequencyKhzList: '8992, 11175',
      notes: 'note',
    });
  });

  it('renders missing coords / notes as empty strings', () => {
    const values = rowToFormValues({
      id: 't1',
      name: 'X',
      latitude: null,
      longitude: null,
      callsign: null,
      frequencyKhzList: [],
      notes: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(values.latitude).toBe('');
    expect(values.longitude).toBe('');
    expect(values.notes).toBe('');
    expect(values.frequencyKhzList).toBe('');
  });
});
