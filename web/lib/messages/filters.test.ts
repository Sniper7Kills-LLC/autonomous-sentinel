import { describe, it, expect } from 'vitest';
import {
  parseFiltersFromParams,
  serializeFiltersToParams,
  filtersToAppSyncFilter,
  isFiltersEmpty,
} from './filters';

describe('parseFiltersFromParams', () => {
  it('extracts every supported field when present', () => {
    const params = new URLSearchParams(
      'type=SKYKING&from=2025-01-01&to=2025-02-01&sender=MAINSAIL&receiver=ANCHOR',
    );
    expect(parseFiltersFromParams(params)).toEqual({
      type: 'SKYKING',
      from: '2025-01-01',
      to: '2025-02-01',
      sender: 'MAINSAIL',
      receiver: 'ANCHOR',
    });
  });

  it('returns empty object when no known fields present', () => {
    expect(parseFiltersFromParams(new URLSearchParams())).toEqual({});
  });

  it('drops invalid type values silently', () => {
    const params = new URLSearchParams('type=NOT_A_REAL_TYPE');
    expect(parseFiltersFromParams(params)).toEqual({});
  });

  it('drops malformed dates but keeps valid neighbours', () => {
    const params = new URLSearchParams('from=2025-99-99&type=SKYKING');
    expect(parseFiltersFromParams(params)).toEqual({ type: 'SKYKING' });
  });

  it('ignores unknown query keys', () => {
    const params = new URLSearchParams('foo=bar&type=BACKEND');
    expect(parseFiltersFromParams(params)).toEqual({ type: 'BACKEND' });
  });
});

describe('serializeFiltersToParams', () => {
  it('round-trips back to the same string', () => {
    const filters = {
      type: 'SKYKING' as const,
      from: '2025-01-01',
      sender: 'MAINSAIL',
    };
    const params = serializeFiltersToParams(filters);
    expect(parseFiltersFromParams(params)).toEqual(filters);
  });

  it('omits undefined fields', () => {
    expect(serializeFiltersToParams({ type: 'BACKEND' }).toString()).toBe('type=BACKEND');
  });
});

describe('filtersToAppSyncFilter', () => {
  it('returns deletedAt-only guard when no filters present', () => {
    expect(filtersToAppSyncFilter({})).toEqual({ deletedAt: { attributeExists: false } });
  });

  it('brackets broadcastTs with from/to range', () => {
    const f = filtersToAppSyncFilter({ from: '2025-01-01', to: '2025-01-31' });
    expect(f).toEqual({
      and: [
        { broadcastTs: { ge: '2025-01-01T00:00:00.000Z' } },
        { broadcastTs: { le: '2025-01-31T23:59:59.999Z' } },
        { deletedAt: { attributeExists: false } },
      ],
    });
  });

  it('uses contains for sender + receiver substring match', () => {
    const f = filtersToAppSyncFilter({ sender: 'MAIN', receiver: 'ANCH' });
    expect(f).toEqual({
      and: [
        { sender: { contains: 'MAIN' } },
        { receiver: { contains: 'ANCH' } },
        { deletedAt: { attributeExists: false } },
      ],
    });
  });
});

describe('isFiltersEmpty', () => {
  it('treats no fields set as empty', () => {
    expect(isFiltersEmpty({})).toBe(true);
  });
  it('treats any field set as non-empty', () => {
    expect(isFiltersEmpty({ type: 'BACKEND' })).toBe(false);
  });
});
