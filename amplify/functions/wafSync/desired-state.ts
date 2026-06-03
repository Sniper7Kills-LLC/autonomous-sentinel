import { cidrVersion } from './cidr';

/**
 * Pure reconciliation math for the WAF-sync Lambda (#198).
 *
 * The Lambda reads banned-IP + banned-country DDB rows and must
 * produce the *desired* WAFv2 state: four IPSets (IPv4/IPv6 ×
 * write/read) plus two country-code lists (write/read). This
 * module computes that desired state from the rows — version
 * routing, expiry filtering, scope fan-out, dedupe, and sort.
 * The Lambda then diffs desired-vs-live and issues UpdateIPSet /
 * rule edits. No AWS SDK, no I/O here so it stays unit-testable.
 *
 * Ban-scope semantics (per CLAUDE.md "Bans + region blocks"):
 * every active ban blocks WRITES; only `read_write`-scoped bans
 * additionally block READS. So each entry lands in the Write list
 * unconditionally and in the Read list only when read_write.
 */

export type BanScope = 'write' | 'read_write';

export interface BannedIpRow {
  cidr: string;
  ipVersion?: string | null;
  scope?: string | null;
  expiresAt?: string | null;
}

export interface BannedCountryRow {
  iso2: string;
  scope?: string | null;
}

export interface DesiredIpSets {
  v4Write: string[];
  v4Read: string[];
  v6Write: string[];
  v6Read: string[];
}

export interface DesiredCountries {
  write: string[];
  read: string[];
}

/**
 * True only for the explicit `'read_write'` scope. Everything
 * else — `'write'`, unknown strings, null, undefined — is
 * write-only (the safe default: never silently read-block).
 */
export function isReadWrite(scope: string | null | undefined): boolean {
  return scope === 'read_write';
}

/**
 * Computes the four desired IPSets from banned-IP rows as of
 * `nowMs`. Rows with an invalid CIDR or an expired `expiresAt`
 * are skipped (not thrown on). Each output array is deduped and
 * ascending-sorted.
 */
export function computeDesiredIpSets(rows: BannedIpRow[], nowMs: number): DesiredIpSets {
  const v4Write = new Set<string>();
  const v4Read = new Set<string>();
  const v6Write = new Set<string>();
  const v6Read = new Set<string>();

  for (const row of rows ?? []) {
    if (!row || typeof row.cidr !== 'string') continue;

    // Prefer the computed version over the (untrusted) stored hint.
    const version = cidrVersion(row.cidr);
    if (version === null) continue; // invalid CIDR — skip

    if (isExpired(row.expiresAt, nowMs)) continue;

    const readWrite = isReadWrite(row.scope);
    if (version === 'IPV4') {
      v4Write.add(row.cidr);
      if (readWrite) v4Read.add(row.cidr);
    } else {
      v6Write.add(row.cidr);
      if (readWrite) v6Read.add(row.cidr);
    }
  }

  return {
    v4Write: sortedUnique(v4Write),
    v4Read: sortedUnique(v4Read),
    v6Write: sortedUnique(v6Write),
    v6Read: sortedUnique(v6Read),
  };
}

/**
 * Computes the desired country-block lists. Each `iso2` is
 * trimmed + upper-cased and must match a two-letter code; others
 * are skipped. Every valid code blocks writes; `read_write`
 * codes also block reads. Both lists are deduped + sorted.
 */
export function computeDesiredCountries(rows: BannedCountryRow[]): DesiredCountries {
  const write = new Set<string>();
  const read = new Set<string>();

  for (const row of rows ?? []) {
    if (!row) continue;
    const iso2 = String(row.iso2).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2)) continue;

    write.add(iso2);
    if (isReadWrite(row.scope)) read.add(iso2);
  }

  return {
    write: sortedUnique(write),
    read: sortedUnique(read),
  };
}

/**
 * A row is expired when `expiresAt` is a non-empty parseable date
 * at or before `nowMs`. An unparseable date is treated as NOT
 * expired (kept) so a malformed timestamp never silently drops an
 * active ban.
 */
function isExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return false; // unparseable → keep
  return parsed <= nowMs;
}

/** Dedupes (via the Set) and returns an ascending string-sorted array. */
function sortedUnique(set: Set<string>): string[] {
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
