import { describe, it, expect } from 'vitest';
import { cidrVersion, isValidCidr } from './cidr';

/**
 * Validation tests for the WAF-sync CIDR classifier (#198).
 *
 * Pins the IPv4 dotted-quad rule, the IPv6 group + single-`::`
 * compression rule, prefix-length bounds, and the trimming /
 * non-string handling. `isValidCidr` is asserted to track
 * `cidrVersion` everywhere.
 */

describe('cidrVersion — valid IPv4', () => {
  it.each([
    ['0.0.0.0/0'],
    ['10.0.0.0/8'],
    ['192.168.1.0/24'],
    ['203.0.113.5/32'],
    ['255.255.255.255/32'],
  ])('%s → IPV4', (cidr) => {
    expect(cidrVersion(cidr)).toBe('IPV4');
    expect(isValidCidr(cidr)).toBe(true);
  });
});

describe('cidrVersion — invalid IPv4', () => {
  it.each([
    ['256.0.0.1/24'], // octet > 255
    ['10.0.0.0/33'], // prefix > 32
    ['10.0.0.0'], // no prefix
    ['10.0.0/24'], // only three octets
    ['10.0.0.0.0/24'], // five octets
    ['10.0.0.0/'], // empty prefix
    ['10.0.0.0/-1'], // negative prefix
  ])('%s → null', (cidr) => {
    expect(cidrVersion(cidr)).toBeNull();
    expect(isValidCidr(cidr)).toBe(false);
  });

  it('rejects non-numeric octet', () => {
    expect(cidrVersion('10.0.0.a/24')).toBeNull();
  });
});

describe('cidrVersion — valid IPv6', () => {
  it.each([
    ['::/0'],
    ['::1/128'],
    ['2001:db8::/32'],
    ['fe80::1/64'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001/128'], // full 8 groups
    ['2001:db8:0:0:0:0:2:1/64'],
  ])('%s → IPV6', (cidr) => {
    expect(cidrVersion(cidr)).toBe('IPV6');
    expect(isValidCidr(cidr)).toBe(true);
  });
});

describe('cidrVersion — invalid IPv6', () => {
  it.each([
    ['gggg::/32'], // non-hex group
    ['2001:db8:::/32'], // triple colon / double compress
    ['2001:db8::/129'], // prefix > 128
    ['2001:db8::1::2/64'], // two `::` compressions
    ['2001:db8:0:0:0:0:0:0:1/64'], // nine groups, no compression
    ['12345::/32'], // group > 4 hex digits
    ['2001:db8::/'], // empty prefix
    [':/64'], // empty address-ish
  ])('%s → null', (cidr) => {
    expect(cidrVersion(cidr)).toBeNull();
    expect(isValidCidr(cidr)).toBe(false);
  });
});

describe('cidrVersion — trimming and non-string input', () => {
  it('trims surrounding whitespace before parsing', () => {
    expect(cidrVersion('  10.0.0.0/8  ')).toBe('IPV4');
    expect(cidrVersion('\t2001:db8::/32\n')).toBe('IPV6');
  });

  it('treats empty / whitespace-only as invalid', () => {
    expect(cidrVersion('')).toBeNull();
    expect(cidrVersion('   ')).toBeNull();
  });

  it('treats non-string-ish input as invalid', () => {
    expect(cidrVersion(null as unknown as string)).toBeNull();
    expect(cidrVersion(undefined as unknown as string)).toBeNull();
    expect(cidrVersion(123 as unknown as string)).toBeNull();
    expect(isValidCidr(null as unknown as string)).toBe(false);
  });
});
