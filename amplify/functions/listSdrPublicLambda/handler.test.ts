import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  blurForPublic,
  isPubliclyVisible,
  __setDeps,
  __resetDeps,
  type ListSdrPublicDeps,
  type SdrRow,
} from './handler';

/**
 * Tests for the `listSdrPublic` Lambda (#286, updated #785).
 *
 * Covers:
 *   - filtering soft-deleted rows (every caller),
 *   - OWNED publicVisible filter for non-admin callers (legacy behavior),
 *   - PUBLIC reviewStatus=APPROVED filter for non-admin callers (#785),
 *   - lat/lon blur math per granularity (EXACT/CITY/REGION/unset),
 *   - admin-bypass returns raw rows (including PENDING/REJECTED public SDRs),
 *   - guest caller treated as non-admin,
 *   - degenerate inputs (non-finite, missing) handled defensively.
 */

function fullIdentity(
  partial: { sub?: string | null; groups?: string[] | null } | null,
): AppSyncResolverEvent<Record<string, never>>['identity'] {
  if (partial === null) return null;
  return {
    sub: partial.sub ?? 'unset-sub',
    issuer: 'https://cognito',
    username: 'test-user',
    claims: {},
    sourceIp: ['203.0.113.1'],
    defaultAuthStrategy: 'ALLOW',
    groups: partial.groups ?? null,
  };
}

function makeEvent(
  identity: { sub?: string | null; groups?: string[] | null } | null = null,
): AppSyncResolverEvent<Record<string, never>> {
  return {
    arguments: {},
    identity: fullIdentity(identity),
    source: null,
    request: { headers: {}, domainName: null },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Query',
      fieldName: 'listSdrPublic',
      variables: {},
    },
    prev: null,
    stash: {},
  };
}

function makeStubs(rows: SdrRow[]): ListSdrPublicDeps & { listSpy: ReturnType<typeof vi.fn> } {
  const listSpy = vi.fn(() => Promise.resolve(rows));
  return { listSpy, listSdrRows: listSpy };
}

describe('blurForPublic — lat/lon granularity math', () => {
  it('EXACT preserves the stored lat/lon to full precision', () => {
    const out = blurForPublic({
      id: 's1',
      latitude: 37.774929,
      longitude: -122.419416,
      locationGranularity: 'EXACT',
    });
    expect(out.latitude).toBe(37.774929);
    expect(out.longitude).toBe(-122.419416);
  });

  it('CITY rounds to 1 decimal place (~11 km)', () => {
    const out = blurForPublic({
      id: 's2',
      latitude: 37.774929,
      longitude: -122.419416,
      locationGranularity: 'CITY',
    });
    expect(out.latitude).toBe(37.8);
    expect(out.longitude).toBe(-122.4);
  });

  it('REGION rounds to 0 decimal places (~111 km)', () => {
    const out = blurForPublic({
      id: 's3',
      latitude: 37.774929,
      longitude: -122.419416,
      locationGranularity: 'REGION',
    });
    expect(out.latitude).toBe(38);
    expect(out.longitude).toBe(-122);
  });

  it('drops lat/lon when granularity is unset (fail closed)', () => {
    const out = blurForPublic({
      id: 's4',
      latitude: 37.774929,
      longitude: -122.419416,
      // no locationGranularity
    });
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });

  it('drops lat/lon when granularity is an unknown enum value (defensive)', () => {
    const out = blurForPublic({
      id: 's5',
      latitude: 37.774929,
      longitude: -122.419416,
      locationGranularity: 'GARBAGE' as unknown as 'EXACT',
    });
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });

  it('handles missing lat/lon (returns null) even when granularity is set', () => {
    const out = blurForPublic({
      id: 's6',
      locationGranularity: 'CITY',
    });
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });

  it('coerces non-finite lat/lon to null (NaN, Infinity)', () => {
    const out = blurForPublic({
      id: 's7',
      latitude: Number.NaN,
      longitude: Number.POSITIVE_INFINITY,
      locationGranularity: 'EXACT',
    });
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });

  it('preserves non-coordinate fields unchanged', () => {
    const out = blurForPublic({
      id: 's8',
      name: 'My SDR',
      notes: 'home rooftop',
      publicVisible: true,
      ownerId: 'owner-1',
      locationGranularity: 'CITY',
      latitude: 37.7,
      longitude: -122.4,
    });
    expect(out.id).toBe('s8');
    expect(out.name).toBe('My SDR');
    expect(out.notes).toBe('home rooftop');
    expect(out.publicVisible).toBe(true);
    expect(out.ownerId).toBe('owner-1');
  });
});

describe('listSdrPublic Lambda (#286)', () => {
  beforeEach(() => __resetDeps());

  it('returns an empty array when the table is empty', async () => {
    __setDeps(makeStubs([]));
    const event = makeEvent();
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result).toEqual([]);
  });

  it('filters soft-deleted rows for every caller (guest)', async () => {
    __setDeps(
      makeStubs([
        { id: 'live', publicVisible: true, locationGranularity: 'EXACT' },
        {
          id: 'dead',
          publicVisible: true,
          locationGranularity: 'EXACT',
          deletedAt: '2025-01-01T00:00:00Z',
        },
      ]),
    );
    const event = makeEvent();
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result.map((r) => r.id)).toEqual(['live']);
  });

  it('filters soft-deleted rows for every caller (admin)', async () => {
    __setDeps(
      makeStubs([
        { id: 'live', publicVisible: false, locationGranularity: 'EXACT' },
        {
          id: 'dead',
          publicVisible: false,
          locationGranularity: 'EXACT',
          deletedAt: '2025-01-01T00:00:00Z',
        },
      ]),
    );
    const event = makeEvent({ sub: 'admin-1', groups: ['admin'] });
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result.map((r) => r.id)).toEqual(['live']);
  });

  it('hides non-publicVisible rows from guest callers', async () => {
    __setDeps(
      makeStubs([
        { id: 'pub', publicVisible: true, locationGranularity: 'EXACT' },
        { id: 'priv', publicVisible: false, locationGranularity: 'EXACT' },
      ]),
    );
    const event = makeEvent();
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result.map((r) => r.id)).toEqual(['pub']);
  });

  it('hides non-publicVisible rows from authenticated non-admin callers', async () => {
    __setDeps(
      makeStubs([
        { id: 'pub', publicVisible: true, locationGranularity: 'EXACT' },
        { id: 'priv', publicVisible: false, locationGranularity: 'EXACT' },
      ]),
    );
    const event = makeEvent({ sub: 'user-1', groups: ['member'] });
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result.map((r) => r.id)).toEqual(['pub']);
  });

  it('admin sees non-publicVisible rows too (raw, unblurred)', async () => {
    __setDeps(
      makeStubs([
        {
          id: 'priv',
          publicVisible: false,
          locationGranularity: 'EXACT',
          latitude: 37.774929,
          longitude: -122.419416,
        },
      ]),
    );
    const event = makeEvent({ sub: 'admin-1', groups: ['admin'] });
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result).toHaveLength(1);
    expect(result[0]?.latitude).toBe(37.774929);
    expect(result[0]?.longitude).toBe(-122.419416);
  });

  it('blurs lat/lon for non-admin callers per granularity', async () => {
    __setDeps(
      makeStubs([
        {
          id: 'a',
          publicVisible: true,
          locationGranularity: 'CITY',
          latitude: 37.774929,
          longitude: -122.419416,
        },
      ]),
    );
    const event = makeEvent();
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result[0]?.latitude).toBe(37.8);
    expect(result[0]?.longitude).toBe(-122.4);
  });

  it('drops lat/lon for non-admin callers when granularity is unset', async () => {
    __setDeps(
      makeStubs([
        {
          id: 'a',
          publicVisible: true,
          latitude: 37.774929,
          longitude: -122.419416,
        },
      ]),
    );
    const event = makeEvent();
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result[0]?.latitude).toBeNull();
    expect(result[0]?.longitude).toBeNull();
  });

  it('treats a caller with no identity.groups as non-admin', async () => {
    __setDeps(
      makeStubs([
        {
          id: 'p',
          publicVisible: true,
          locationGranularity: 'CITY',
          latitude: 37.774929,
          longitude: -122.419416,
        },
      ]),
    );
    const event = makeEvent({ sub: 'user-only', groups: null });
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result[0]?.latitude).toBe(37.8);
  });
});

describe('isPubliclyVisible — #785 OWNED vs PUBLIC visibility rules', () => {
  it('OWNED row with publicVisible=true is visible', () => {
    expect(isPubliclyVisible({ id: 's1', kind: 'OWNED', publicVisible: true })).toBe(true);
  });

  it('OWNED row with publicVisible=false is not visible', () => {
    expect(isPubliclyVisible({ id: 's2', kind: 'OWNED', publicVisible: false })).toBe(false);
  });

  it('PUBLIC row with reviewStatus=APPROVED is visible', () => {
    expect(
      isPubliclyVisible({ id: 's3', kind: 'PUBLIC', reviewStatus: 'APPROVED', publicVisible: false }),
    ).toBe(true);
  });

  it('PUBLIC row with reviewStatus=PENDING is not visible', () => {
    expect(
      isPubliclyVisible({ id: 's4', kind: 'PUBLIC', reviewStatus: 'PENDING', publicVisible: true }),
    ).toBe(false);
  });

  it('PUBLIC row with reviewStatus=REJECTED is not visible', () => {
    expect(
      isPubliclyVisible({ id: 's5', kind: 'PUBLIC', reviewStatus: 'REJECTED' }),
    ).toBe(false);
  });

  it('legacy row without kind (pre-#785) treated as OWNED — respects publicVisible', () => {
    expect(isPubliclyVisible({ id: 's6', publicVisible: true })).toBe(true);
    expect(isPubliclyVisible({ id: 's7', publicVisible: false })).toBe(false);
  });

  it('PUBLIC APPROVED SDRs appear in public map listing', async () => {
    __setDeps(
      makeStubs([
        { id: 'approved', kind: 'PUBLIC', reviewStatus: 'APPROVED', locationGranularity: 'EXACT', latitude: 1.0, longitude: 2.0 },
        { id: 'pending', kind: 'PUBLIC', reviewStatus: 'PENDING', locationGranularity: 'EXACT', latitude: 3.0, longitude: 4.0 },
        { id: 'rejected', kind: 'PUBLIC', reviewStatus: 'REJECTED', locationGranularity: 'EXACT', latitude: 5.0, longitude: 6.0 },
      ]),
    );
    const event = makeEvent();
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result.map((r) => r.id)).toEqual(['approved']);
  });

  it('admin sees all PUBLIC SDRs regardless of reviewStatus', async () => {
    __setDeps(
      makeStubs([
        { id: 'approved', kind: 'PUBLIC', reviewStatus: 'APPROVED', locationGranularity: 'EXACT' },
        { id: 'pending', kind: 'PUBLIC', reviewStatus: 'PENDING', locationGranularity: 'EXACT' },
        { id: 'rejected', kind: 'PUBLIC', reviewStatus: 'REJECTED', locationGranularity: 'EXACT' },
      ]),
    );
    const event = makeEvent({ sub: 'admin-1', groups: ['admin'] });
    const result = (await handler(event, {} as Context, () => undefined)) as SdrRow[];
    expect(result.map((r) => r.id).sort()).toEqual(['approved', 'pending', 'rejected']);
  });
});
