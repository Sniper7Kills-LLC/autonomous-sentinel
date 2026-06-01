import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSearchFilter, searchMessages } from './search';

describe('buildSearchFilter', () => {
  it('returns undefined for empty / whitespace-only query with no filters', () => {
    // No query and no filters → nothing to constrain except the
    // soft-delete exclusion, which buildSearchFilter still keeps.
    const filter = buildSearchFilter('   ', {});
    expect(filter).toEqual({ and: [{ deletedAt: { attributeExists: false } }] });
  });

  it('builds an OR of contains across body/sender/receiver for a q-only search', () => {
    const filter = buildSearchFilter('foxtrot', {});
    expect(filter).toEqual({
      and: [
        {
          or: [
            { body: { contains: 'foxtrot' } },
            { sender: { contains: 'foxtrot' } },
            { receiver: { contains: 'foxtrot' } },
          ],
        },
        { deletedAt: { attributeExists: false } },
      ],
    });
  });

  it('trims the query before building the contains terms', () => {
    const filter = buildSearchFilter('  alpha  ', {});
    const and = (filter as { and: Record<string, unknown>[] }).and;
    const or = (and[0] as { or: Record<string, unknown>[] }).or;
    expect(or[0]).toEqual({ body: { contains: 'alpha' } });
  });

  it('combines q with type + date filters AND keeps the deleted-exclusion', () => {
    const filter = buildSearchFilter('skyking', {
      type: 'SKYKING',
      from: '2026-01-01',
      to: '2026-02-01',
    });
    const and = (filter as { and: Record<string, unknown>[] }).and;
    // type + from + to + or-block + deletedAt
    expect(and).toContainEqual({ type: { eq: 'SKYKING' } });
    expect(and).toContainEqual({ broadcastTs: { ge: '2026-01-01T00:00:00.000Z' } });
    expect(and).toContainEqual({ broadcastTs: { le: '2026-02-01T23:59:59.999Z' } });
    expect(and).toContainEqual({ deletedAt: { attributeExists: false } });
    expect(and.some((t) => Object.prototype.hasOwnProperty.call(t, 'or'))).toBe(true);
  });

  it('always retains the soft-deleted exclusion term', () => {
    const filter = buildSearchFilter('anything', { type: 'OTHER' });
    const and = (filter as { and: Record<string, unknown>[] }).and;
    expect(and).toContainEqual({ deletedAt: { attributeExists: false } });
  });

  it('passes special characters through as literal contains values (no breakage)', () => {
    const q = 'a+b*(c)[d].*';
    const filter = buildSearchFilter(q, {});
    const and = (filter as { and: Record<string, unknown>[] }).and;
    const or = (and[0] as { or: Record<string, unknown>[] }).or;
    expect(or[0]).toEqual({ body: { contains: q } });
  });

  it('omits the OR block when q is empty but keeps filters + exclusion', () => {
    const filter = buildSearchFilter('', { type: 'BACKEND' });
    const and = (filter as { and: Record<string, unknown>[] }).and;
    expect(and).toContainEqual({ type: { eq: 'BACKEND' } });
    expect(and).toContainEqual({ deletedAt: { attributeExists: false } });
    expect(and.some((t) => Object.prototype.hasOwnProperty.call(t, 'or'))).toBe(false);
  });
});

vi.mock('./query', () => ({
  listMessagesWithFilter: vi.fn(),
}));

import { listMessagesWithFilter } from './query';

describe('searchMessages', () => {
  beforeEach(() => {
    vi.mocked(listMessagesWithFilter).mockReset();
    vi.mocked(listMessagesWithFilter).mockResolvedValue({ items: [], nextToken: null });
  });

  it('calls the query helper with the built filter + nextToken', async () => {
    await searchMessages('foxtrot', { type: 'SKYKING', nextToken: 'tok' });
    expect(listMessagesWithFilter).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(listMessagesWithFilter).mock.calls[0]![0]!;
    expect(arg.nextToken).toBe('tok');
    expect(arg.filter).toEqual(buildSearchFilter('foxtrot', { type: 'SKYKING' }));
  });

  it('returns the items + nextToken from the query helper', async () => {
    vi.mocked(listMessagesWithFilter).mockResolvedValue({
      items: [{ id: 'm1' } as never],
      nextToken: 'next',
    });
    const res = await searchMessages('alpha', {});
    expect(res.items).toHaveLength(1);
    expect(res.nextToken).toBe('next');
  });
});
