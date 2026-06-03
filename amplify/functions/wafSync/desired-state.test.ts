import { describe, it, expect } from 'vitest';
import {
  computeDesiredCountries,
  computeDesiredIpSets,
  isReadWrite,
  type BannedCountryRow,
  type BannedIpRow,
} from './desired-state';

/**
 * Reconciliation-math tests for the WAF-sync desired-state
 * computation (#198).
 *
 * Pins scope fan-out (write-only vs read_write), expiry
 * filtering, invalid-CIDR skipping, dedupe, sort, and the
 * country-code normalization. A fixed `NOW_MS` anchors every
 * expiry assertion — no `Date.now()`.
 */

const NOW_MS = Date.parse('2026-06-02T00:00:00Z');
const PAST = '2026-06-01T00:00:00Z';
const FUTURE = '2026-12-31T00:00:00Z';

describe('isReadWrite', () => {
  it('is true only for the exact read_write string', () => {
    expect(isReadWrite('read_write')).toBe(true);
    expect(isReadWrite('write')).toBe(false);
    expect(isReadWrite('READ_WRITE')).toBe(false);
    expect(isReadWrite('')).toBe(false);
    expect(isReadWrite(null)).toBe(false);
    expect(isReadWrite(undefined)).toBe(false);
  });
});

describe('computeDesiredIpSets — scope fan-out', () => {
  it('puts a write-only IPv4 row in v4Write but not v4Read', () => {
    const rows: BannedIpRow[] = [{ cidr: '10.0.0.0/8', scope: 'write' }];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8']);
    expect(out.v4Read).toEqual([]);
    expect(out.v6Write).toEqual([]);
    expect(out.v6Read).toEqual([]);
  });

  it('defaults a row with no scope to write-only', () => {
    const out = computeDesiredIpSets([{ cidr: '10.0.0.0/8' }], NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8']);
    expect(out.v4Read).toEqual([]);
  });

  it('puts a read_write IPv6 row in both v6Write and v6Read', () => {
    const rows: BannedIpRow[] = [{ cidr: '2001:db8::/32', scope: 'read_write' }];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v6Write).toEqual(['2001:db8::/32']);
    expect(out.v6Read).toEqual(['2001:db8::/32']);
    expect(out.v4Write).toEqual([]);
  });
});

describe('computeDesiredIpSets — expiry', () => {
  it('drops an expired row from every list', () => {
    const rows: BannedIpRow[] = [{ cidr: '10.0.0.0/8', scope: 'read_write', expiresAt: PAST }];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual([]);
    expect(out.v4Read).toEqual([]);
  });

  it('keeps a future-expiry row', () => {
    const rows: BannedIpRow[] = [{ cidr: '10.0.0.0/8', expiresAt: FUTURE }];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8']);
  });

  it('keeps a row with an unparseable expiresAt', () => {
    const rows: BannedIpRow[] = [{ cidr: '10.0.0.0/8', expiresAt: 'not-a-date' }];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8']);
  });

  it('keeps a row with an empty expiresAt string', () => {
    const rows: BannedIpRow[] = [{ cidr: '10.0.0.0/8', expiresAt: '' }];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8']);
  });
});

describe('computeDesiredIpSets — invalid + dedupe + sort', () => {
  it('silently skips an invalid-CIDR row without throwing', () => {
    const rows: BannedIpRow[] = [
      { cidr: 'not-a-cidr' },
      { cidr: '999.0.0.0/8' },
      { cidr: '10.0.0.0/8' },
    ];
    expect(() => computeDesiredIpSets(rows, NOW_MS)).not.toThrow();
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8']);
  });

  it('ignores a misleading ipVersion hint and uses the computed version', () => {
    const rows: BannedIpRow[] = [{ cidr: '2001:db8::/32', ipVersion: 'IPV4' }];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual([]);
    expect(out.v6Write).toEqual(['2001:db8::/32']);
  });

  it('dedupes two rows with the same cidr to one entry', () => {
    const rows: BannedIpRow[] = [
      { cidr: '10.0.0.0/8', scope: 'write' },
      { cidr: '10.0.0.0/8', scope: 'read_write' },
    ];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8']);
    // The read_write occurrence still lands the cidr in the read set.
    expect(out.v4Read).toEqual(['10.0.0.0/8']);
  });

  it('sorts each output list ascending', () => {
    const rows: BannedIpRow[] = [
      { cidr: '192.168.0.0/16' },
      { cidr: '10.0.0.0/8' },
      { cidr: '172.16.0.0/12' },
    ];
    const out = computeDesiredIpSets(rows, NOW_MS);
    expect(out.v4Write).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
  });

  it('handles an empty / nullish rows input', () => {
    expect(computeDesiredIpSets([], NOW_MS)).toEqual({
      v4Write: [],
      v4Read: [],
      v6Write: [],
      v6Read: [],
    });
    expect(computeDesiredIpSets(null as unknown as BannedIpRow[], NOW_MS)).toEqual({
      v4Write: [],
      v4Read: [],
      v6Write: [],
      v6Read: [],
    });
  });
});

describe('computeDesiredCountries', () => {
  it('normalizes lowercase iso2 to upper-case', () => {
    const out = computeDesiredCountries([{ iso2: 'us' }]);
    expect(out.write).toEqual(['US']);
  });

  it('skips invalid codes (USA, 1A, empty)', () => {
    const rows: BannedCountryRow[] = [
      { iso2: 'USA' },
      { iso2: '1A' },
      { iso2: '' },
      { iso2: '  ' },
      { iso2: 'GB' },
    ];
    const out = computeDesiredCountries(rows);
    expect(out.write).toEqual(['GB']);
  });

  it('puts read_write in both write and read; write-only only in write', () => {
    const rows: BannedCountryRow[] = [
      { iso2: 'us', scope: 'read_write' },
      { iso2: 'gb', scope: 'write' },
    ];
    const out = computeDesiredCountries(rows);
    expect(out.write).toEqual(['GB', 'US']);
    expect(out.read).toEqual(['US']);
  });

  it('dedupes and sorts country codes', () => {
    const rows: BannedCountryRow[] = [
      { iso2: 'ru' },
      { iso2: 'cn' },
      { iso2: 'RU' },
      { iso2: 'kp' },
    ];
    const out = computeDesiredCountries(rows);
    expect(out.write).toEqual(['CN', 'KP', 'RU']);
  });

  it('handles an empty / nullish rows input', () => {
    expect(computeDesiredCountries([])).toEqual({ write: [], read: [] });
    expect(computeDesiredCountries(null as unknown as BannedCountryRow[])).toEqual({
      write: [],
      read: [],
    });
  });
});
