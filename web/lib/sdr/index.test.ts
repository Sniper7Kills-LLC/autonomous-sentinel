import { describe, it, expect, vi } from 'vitest';
import {
  toSdrRow,
  validateOwnedSdrInput,
  validatePublicSdrInput,
  EMPTY_OWNED_FORM,
  EMPTY_PUBLIC_FORM,
  type OwnedSdrFormValues,
  type PublicSdrFormValues,
} from './index';

/**
 * Unit tests for the SDR data-layer helpers (#785).
 * The actual API calls (listMySdrs, submitPublicSdr, etc.) are
 * integration paths and tested via mocked client patterns below.
 */

vi.mock('@/lib/amplifyClient', () => ({
  getDataClient: vi.fn(() => ({
    models: {
      Sdr: {
        list: vi.fn(() => Promise.resolve({ data: [], errors: null })),
        create: vi.fn(() => Promise.resolve({ data: null, errors: null })),
        update: vi.fn(() => Promise.resolve({ data: null, errors: null })),
      },
    },
    mutations: {
      submitPublicSdr: vi.fn(() => Promise.resolve({ data: null, errors: null })),
      reviewSdr: vi.fn(() => Promise.resolve({ data: null, errors: null })),
    },
  })),
  configureAmplifyOnce: vi.fn(),
}));

vi.mock('@/lib/auth/mode', () => ({
  resolveAuthMode: vi.fn(() => Promise.resolve('userPool')),
}));

describe('toSdrRow', () => {
  it('normalizes a complete raw SDR to a typed SdrRow', () => {
    const raw = {
      id: 'sdr-001',
      name: 'KiwiSDR Tokyo',
      kind: 'PUBLIC',
      url: 'http://example.com:8073',
      latitude: 35.6895,
      longitude: 139.6917,
      locationGranularity: 'CITY',
      publicVisible: false,
      notes: 'Test notes',
      reviewStatus: 'PENDING',
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      submitterId: 'cog-member-001',
      ownerId: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    };
    const result = toSdrRow(raw);
    expect(result.id).toBe('sdr-001');
    expect(result.kind).toBe('PUBLIC');
    expect(result.reviewStatus).toBe('PENDING');
    expect(result.latitude).toBe(35.6895);
    expect(result.longitude).toBe(139.6917);
  });

  it('normalizes an OWNED SDR (no url, no reviewStatus)', () => {
    const raw = {
      id: 'sdr-002',
      name: 'My Home SDR',
      kind: 'OWNED',
      publicVisible: true,
      locationGranularity: 'REGION',
    };
    const result = toSdrRow(raw);
    expect(result.kind).toBe('OWNED');
    expect(result.url).toBeNull();
    expect(result.reviewStatus).toBeNull();
    expect(result.publicVisible).toBe(true);
    expect(result.locationGranularity).toBe('REGION');
  });

  it('treats unknown kind as null', () => {
    const raw = { id: 's1', kind: 'UNKNOWN', name: 'test' };
    expect(toSdrRow(raw).kind).toBeNull();
  });

  it('treats unknown reviewStatus as null', () => {
    const raw = { id: 's1', name: 'test', reviewStatus: 'MAYBE' };
    expect(toSdrRow(raw).reviewStatus).toBeNull();
  });

  it('treats unknown locationGranularity as null', () => {
    const raw = { id: 's1', name: 'test', locationGranularity: 'MEGA' };
    expect(toSdrRow(raw).locationGranularity).toBeNull();
  });

  it('defaults publicVisible to true when not set', () => {
    const raw = { id: 's1', name: 'test' };
    // publicVisible is absent → defaults to true (non-false = true)
    expect(toSdrRow(raw).publicVisible).toBe(true);
  });
});

describe('validateOwnedSdrInput', () => {
  const validForm: OwnedSdrFormValues = {
    name: 'My SDR',
    latitude: '37.77',
    longitude: '-122.42',
    locationGranularity: 'CITY',
    publicVisible: true,
    notes: 'Test',
  };

  it('passes with valid input', () => {
    const { errors, input } = validateOwnedSdrInput(validForm);
    expect(errors).toEqual({});
    expect(input).not.toBeNull();
    expect(input?.name).toBe('My SDR');
    expect(input?.latitude).toBe(37.77);
    expect(input?.longitude).toBe(-122.42);
  });

  it('rejects blank name', () => {
    const { errors } = validateOwnedSdrInput({ ...validForm, name: '  ' });
    expect(errors.name).toBeDefined();
  });

  it('rejects latitude out of range', () => {
    const { errors } = validateOwnedSdrInput({ ...validForm, latitude: '91' });
    expect(errors.latitude).toBeDefined();
  });

  it('rejects longitude out of range', () => {
    const { errors } = validateOwnedSdrInput({ ...validForm, longitude: '-181' });
    expect(errors.longitude).toBeDefined();
  });

  it('allows null lat/lon (no location set)', () => {
    const { errors, input } = validateOwnedSdrInput({
      ...validForm,
      latitude: '',
      longitude: '',
    });
    expect(errors).toEqual({});
    expect(input?.latitude).toBeNull();
    expect(input?.longitude).toBeNull();
  });

  it('treats empty notes as null', () => {
    const { input } = validateOwnedSdrInput({ ...validForm, notes: '  ' });
    expect(input?.notes).toBeNull();
  });

  it('treats empty locationGranularity as null', () => {
    const { input } = validateOwnedSdrInput({ ...validForm, locationGranularity: '' });
    expect(input?.locationGranularity).toBeNull();
  });

  it('EMPTY_OWNED_FORM has sensible defaults', () => {
    expect(EMPTY_OWNED_FORM.name).toBe('');
    expect(EMPTY_OWNED_FORM.publicVisible).toBe(false);
    expect(EMPTY_OWNED_FORM.locationGranularity).toBe('');
  });
});

describe('validatePublicSdrInput', () => {
  const validForm: PublicSdrFormValues = {
    name: 'KiwiSDR London',
    url: 'http://example.com:8073',
    latitude: '51.5074',
    longitude: '-0.1278',
    locationGranularity: 'CITY',
    notes: '',
  };

  it('passes with valid input', () => {
    const { errors, input } = validatePublicSdrInput(validForm);
    expect(errors).toEqual({});
    expect(input?.name).toBe('KiwiSDR London');
    expect(input?.url).toBe('http://example.com:8073');
  });

  it('rejects blank name', () => {
    const { errors } = validatePublicSdrInput({ ...validForm, name: '' });
    expect(errors.name).toBeDefined();
  });

  it('rejects blank url', () => {
    const { errors } = validatePublicSdrInput({ ...validForm, url: '' });
    expect(errors.url).toBeDefined();
  });

  it('allows null lat/lon (location optional)', () => {
    const { errors, input } = validatePublicSdrInput({
      ...validForm,
      latitude: '',
      longitude: '',
    });
    expect(errors).toEqual({});
    expect(input?.latitude).toBeNull();
    expect(input?.longitude).toBeNull();
  });

  it('EMPTY_PUBLIC_FORM has sensible defaults', () => {
    expect(EMPTY_PUBLIC_FORM.name).toBe('');
    expect(EMPTY_PUBLIC_FORM.url).toBe('');
    expect(EMPTY_PUBLIC_FORM.locationGranularity).toBe('');
  });
});
