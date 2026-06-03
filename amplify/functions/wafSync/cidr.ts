/**
 * Pure CIDR validation for the WAF-sync Lambda (#198).
 *
 * The WAF-sync Lambda reconciles banned-IP DDB rows into WAFv2
 * IPSets, which are strictly typed IPV4 vs IPV6. This module is
 * the pure validation slice — it classifies a CIDR string as
 * IPv4, IPv6, or invalid so the reconciler can route each row to
 * the correct IPSet (and drop garbage rows). No AWS SDK, no I/O.
 *
 * Scope: standard `A.B.C.D/N` IPv4 and `<addr>/N` IPv6 with at
 * most one `::` compression. IPv4-mapped IPv6 (`::ffff:1.2.3.4`)
 * is intentionally NOT supported and is rejected.
 */

export type IpVersion = 'IPV4' | 'IPV6';

/**
 * Classifies a CIDR string. Returns `'IPV4'` / `'IPV6'` for a
 * well-formed CIDR of that family, or `null` when the input is
 * not a usable CIDR. Input is trimmed first; non-string-ish input
 * is invalid.
 */
export function cidrVersion(cidr: string): IpVersion | null {
  if (typeof cidr !== 'string') return null;
  const trimmed = cidr.trim();
  if (trimmed.length === 0) return null;

  const slash = trimmed.indexOf('/');
  if (slash < 0) return null; // prefix is required
  const addr = trimmed.slice(0, slash);
  const prefixStr = trimmed.slice(slash + 1);

  if (addr.length === 0 || prefixStr.length === 0) return null;

  if (isValidIpv4(addr) && isValidPrefix(prefixStr, 32)) return 'IPV4';
  if (isValidIpv6(addr) && isValidPrefix(prefixStr, 128)) return 'IPV6';
  return null;
}

/** Convenience predicate — true when `cidrVersion` classifies the input. */
export function isValidCidr(cidr: string): boolean {
  return cidrVersion(cidr) !== null;
}

/**
 * Validates the prefix length: an integer in `[0, max]` with no
 * sign, decimal point, or stray characters.
 */
function isValidPrefix(prefixStr: string, max: number): boolean {
  if (!/^\d+$/.test(prefixStr)) return false;
  const n = Number(prefixStr);
  return Number.isInteger(n) && n >= 0 && n <= max;
}

/** Validates a dotted-quad IPv4 address (four octets, each 0–255). */
function isValidIpv4(addr: string): boolean {
  const octets = addr.split('.');
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) return false;
    // Cap raw length so absurdly long all-digit strings don't slip
    // through the >255 numeric check via float weirdness.
    if (octet.length > 3) return false;
    const n = Number(octet);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * Validates an IPv6 address: groups of 1–4 hex digits joined by
 * `:`, with at most one `::` compression standing in for one or
 * more zero groups. A full uncompressed address has exactly 8
 * groups. IPv4-mapped forms are not supported.
 */
function isValidIpv6(addr: string): boolean {
  // At most one `::`.
  const doubleColonCount = (addr.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return false;
  // A `:::` (or longer) run never appears once `::` count is ≤ 1,
  // but a stray run like `2001:::1` must be rejected explicitly.
  if (/:::/.test(addr)) return false;

  if (doubleColonCount === 1) {
    const parts = addr.split('::');
    const head = parts[0] ?? '';
    const tail = parts[1] ?? '';
    const headGroups = head.length === 0 ? [] : head.split(':');
    const tailGroups = tail.length === 0 ? [] : tail.split(':');
    if (!headGroups.every(isHexGroup)) return false;
    if (!tailGroups.every(isHexGroup)) return false;
    // `::` stands in for ≥1 zero group, so the explicit groups must
    // total at most 7 (leaving room for the compression to fill ≥1).
    return headGroups.length + tailGroups.length <= 7;
  }

  // No compression: must be exactly 8 well-formed groups.
  const groups = addr.split(':');
  if (groups.length !== 8) return false;
  return groups.every(isHexGroup);
}

/** A single IPv6 group: 1–4 hex digits. */
function isHexGroup(group: string): boolean {
  return /^[0-9a-fA-F]{1,4}$/.test(group);
}
