import { describe, it, expect } from 'vitest';
import { cidrVersion, isValidCidr, toCountryBanRow, toIpBanRow } from './waf-bans';

describe('waf-bans CIDR validation', () => {
  it('accepts valid IPv4 CIDRs', () => {
    expect(cidrVersion('0.0.0.0/0')).toBe('IPV4');
    expect(cidrVersion('10.0.0.0/8')).toBe('IPV4');
    expect(cidrVersion('203.0.113.5/32')).toBe('IPV4');
    expect(isValidCidr(' 192.168.1.0/24 ')).toBe(true); // trims
  });

  it('rejects malformed IPv4', () => {
    expect(cidrVersion('256.0.0.1/24')).toBeNull();
    expect(cidrVersion('10.0.0.0/33')).toBeNull();
    expect(cidrVersion('10.0.0.0')).toBeNull(); // no prefix
    expect(cidrVersion('10.0.0/24')).toBeNull();
    expect(isValidCidr('not-an-ip')).toBe(false);
  });

  it('accepts valid IPv6 CIDRs', () => {
    expect(cidrVersion('::/0')).toBe('IPV6');
    expect(cidrVersion('::1/128')).toBe('IPV6');
    expect(cidrVersion('2001:db8::/32')).toBe('IPV6');
    expect(cidrVersion('fe80::1/64')).toBe('IPV6');
  });

  it('rejects malformed IPv6', () => {
    expect(cidrVersion('gggg::/32')).toBeNull();
    expect(cidrVersion('2001:db8:::/32')).toBeNull(); // double ::
    expect(cidrVersion('2001:db8::/129')).toBeNull();
  });
});

describe('waf-bans row mappers', () => {
  it('normalizes country scope (anything not read_write → write)', () => {
    expect(toCountryBanRow({ iso2: 'RU', scope: 'read_write' }).scope).toBe('read_write');
    expect(toCountryBanRow({ iso2: 'CN', scope: 'write' }).scope).toBe('write');
    expect(toCountryBanRow({ iso2: 'KP', scope: null }).scope).toBe('write');
    expect(toCountryBanRow({ iso2: 'KP' }).scope).toBe('write');
  });

  it('maps an IP row with version + nullable fields', () => {
    const row = toIpBanRow({
      cidr: '203.0.113.0/24',
      ipVersion: 'IPV4',
      scope: 'read_write',
      reason: 'abuse',
      expiresAt: '2026-07-01T00:00:00.000Z',
      createdBy: 'admin-1',
    });
    expect(row).toEqual({
      cidr: '203.0.113.0/24',
      ipVersion: 'IPV4',
      scope: 'read_write',
      reason: 'abuse',
      expiresAt: '2026-07-01T00:00:00.000Z',
      createdBy: 'admin-1',
      createdAt: null,
    });
  });

  it('defaults IP version to IPV4 when absent and reason/expiry to null', () => {
    const row = toIpBanRow({ cidr: '198.51.100.0/24' });
    expect(row.ipVersion).toBe('IPV4');
    expect(row.reason).toBeNull();
    expect(row.expiresAt).toBeNull();
    expect(row.scope).toBe('write');
  });
});
