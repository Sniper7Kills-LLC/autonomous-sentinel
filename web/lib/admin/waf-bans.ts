'use client';

import { getDataClient } from '@/lib/amplifyClient';

/**
 * Admin country / IP-CIDR ban data layer (#112 IP + Country tabs).
 *
 * Backs the `/admin/bans` IP-CIDR and Country tabs. Country + IP blocks are
 * plain CRUD over the admin-only `BannedCountry` / `BannedIp` models; the
 * `wafSync` Lambda (#199/#200) reconciles those rows onto live WAF state via
 * the tables' DynamoDB streams, so the UI only writes the rows — there is no
 * separate "call the WAF" step here.
 *
 * All mutations use the `userPool` auth mode: the models are admin-only grants
 * enforced server-side via the JWT group claim; this layer only assembles data
 * and stamps `createdBy` with the acting admin's Cognito sub for provenance.
 *
 * Audit-log entries for country/IP ban add/remove are tracked separately (the
 * native model CRUD path does not write AuditLog the way the `banUser` custom
 * mutation does) — see the follow-up issue referenced on the PR.
 */

const USER_POOL = { authMode: 'userPool' as const };

export type BanScope = 'write' | 'read_write';
export type IpVersion = 'IPV4' | 'IPV6';

export interface CountryBanRow {
  iso2: string;
  scope: BanScope;
  reason: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface IpBanRow {
  cidr: string;
  ipVersion: IpVersion;
  scope: BanScope;
  reason: string | null;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

type RawCountry = {
  iso2: string;
  scope?: string | null;
  reason?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
};
type RawIp = {
  cidr: string;
  ipVersion?: string | null;
  scope?: string | null;
  reason?: string | null;
  expiresAt?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
};
type RawList<T> = {
  data?: T[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};
type RawOne<T> = { data?: T | null; errors?: { message: string }[] | null };

function throwOnErrors(res: { errors?: { message: string }[] | null }, op: string): void {
  if (res.errors?.length)
    throw new Error(`${op} failed: ${res.errors.map((e) => e.message).join('; ')}`);
}

function normalizeScope(raw: string | null | undefined): BanScope {
  return raw === 'read_write' ? 'read_write' : 'write';
}

export function toCountryBanRow(r: RawCountry): CountryBanRow {
  return {
    iso2: r.iso2,
    scope: normalizeScope(r.scope),
    reason: r.reason ?? null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt ?? null,
  };
}

export function toIpBanRow(r: RawIp): IpBanRow {
  return {
    cidr: r.cidr,
    ipVersion: r.ipVersion === 'IPV6' ? 'IPV6' : 'IPV4',
    scope: normalizeScope(r.scope),
    reason: r.reason ?? null,
    expiresAt: r.expiresAt ?? null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* CIDR validation (mirrors amplify/functions/wafSync/cidr.ts)         */
/* ------------------------------------------------------------------ */

/** Return the IP version of a valid CIDR, or null if malformed. */
export function cidrVersion(raw: string): IpVersion | null {
  const cidr = String(raw ?? '').trim();
  if (!cidr.includes('/')) return null;
  const [addr, prefixStr, ...rest] = cidr.split('/');
  if (rest.length > 0 || addr === undefined || prefixStr === undefined) return null;
  if (!/^\d+$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const octets = addr.split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    if (prefix < 0 || prefix > 32) return null;
    return 'IPV4';
  }

  // IPv6
  if (addr.includes(':')) {
    if (prefix < 0 || prefix > 128) return null;
    const doubleColon = addr.split('::');
    if (doubleColon.length > 2) return null;
    // Each side of `::` must be non-empty hextets; emptiness is only allowed
    // for the whole side (handled by the `=== '' ? []` guards below), so a
    // stray third colon like `2001:db8:::` yields an empty group → invalid.
    const hextet = (g: string) => /^[0-9a-fA-F]{1,4}$/.test(g);
    if (doubleColon.length === 2) {
      const head = doubleColon[0] === '' ? [] : doubleColon[0]!.split(':');
      const tail = doubleColon[1] === '' ? [] : doubleColon[1]!.split(':');
      if (![...head, ...tail].every(hextet)) return null;
      return head.length + tail.length <= 7 ? 'IPV6' : null;
    }
    const groups = addr.split(':');
    if (groups.length !== 8) return null;
    if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return 'IPV6';
  }

  return null;
}

export function isValidCidr(raw: string): boolean {
  return cidrVersion(raw) !== null;
}

/* ------------------------------------------------------------------ */
/* Actor                                                               */
/* ------------------------------------------------------------------ */

/** Current admin's Cognito sub (for `createdBy`), or null if unavailable. */
export async function currentActorSub(): Promise<string | null> {
  try {
    const { getCurrentUser } = await import('aws-amplify/auth');
    const user = await getCurrentUser();
    return user.userId ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Country bans                                                        */
/* ------------------------------------------------------------------ */

export async function listCountryBans(): Promise<CountryBanRow[]> {
  const client = getDataClient();
  const listFn = client.models.BannedCountry.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawList<RawCountry>>;
  const out: CountryBanRow[] = [];
  let nextToken: string | null | undefined;
  do {
    const raw = await listFn({ limit: 1000, nextToken: nextToken ?? undefined, ...USER_POOL });
    throwOnErrors(raw, 'listCountryBans');
    for (const r of raw.data ?? []) out.push(toCountryBanRow(r));
    nextToken = raw.nextToken;
  } while (nextToken);
  return out.sort((a, b) => a.iso2.localeCompare(b.iso2));
}

export async function addCountryBan(input: {
  iso2: string;
  scope: BanScope;
  reason: string;
}): Promise<void> {
  const client = getDataClient();
  const createFn = client.models.BannedCountry.create as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawOne<RawCountry>>;
  const createdBy = await currentActorSub();
  const res = await createFn(
    {
      iso2: input.iso2.trim().toUpperCase(),
      scope: input.scope,
      reason: input.reason.trim() || undefined,
      createdBy: createdBy ?? undefined,
    },
    USER_POOL,
  );
  throwOnErrors(res, 'addCountryBan');
}

export async function removeCountryBan(iso2: string): Promise<void> {
  const client = getDataClient();
  const deleteFn = client.models.BannedCountry.delete as unknown as (
    input: { iso2: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawOne<RawCountry>>;
  const res = await deleteFn({ iso2 }, USER_POOL);
  throwOnErrors(res, 'removeCountryBan');
}

/* ------------------------------------------------------------------ */
/* IP-CIDR bans                                                        */
/* ------------------------------------------------------------------ */

export async function listIpBans(): Promise<IpBanRow[]> {
  const client = getDataClient();
  const listFn = client.models.BannedIp.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawList<RawIp>>;
  const out: IpBanRow[] = [];
  let nextToken: string | null | undefined;
  do {
    const raw = await listFn({ limit: 1000, nextToken: nextToken ?? undefined, ...USER_POOL });
    throwOnErrors(raw, 'listIpBans');
    for (const r of raw.data ?? []) out.push(toIpBanRow(r));
    nextToken = raw.nextToken;
  } while (nextToken);
  return out.sort((a, b) => a.cidr.localeCompare(b.cidr));
}

export async function addIpBan(input: {
  cidr: string;
  scope: BanScope;
  reason: string;
  expiresAt: string | null;
}): Promise<void> {
  const cidr = input.cidr.trim();
  const version = cidrVersion(cidr);
  if (!version) throw new Error(`Invalid CIDR: ${cidr}`);
  const client = getDataClient();
  const createFn = client.models.BannedIp.create as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawOne<RawIp>>;
  const createdBy = await currentActorSub();
  const res = await createFn(
    {
      cidr,
      ipVersion: version,
      scope: input.scope,
      reason: input.reason.trim() || undefined,
      expiresAt: input.expiresAt ?? undefined,
      createdBy: createdBy ?? undefined,
    },
    USER_POOL,
  );
  throwOnErrors(res, 'addIpBan');
}

export async function removeIpBan(cidr: string): Promise<void> {
  const client = getDataClient();
  const deleteFn = client.models.BannedIp.delete as unknown as (
    input: { cidr: string },
    opts?: Record<string, unknown>,
  ) => Promise<RawOne<RawIp>>;
  const res = await deleteFn({ cidr }, USER_POOL);
  throwOnErrors(res, 'removeIpBan');
}

/* ------------------------------------------------------------------ */
/* WAF metrics (#673)                                                  */
/* ------------------------------------------------------------------ */

export interface WafMetrics {
  webAcl: string;
  windowHours: number;
  blockedRequests: number;
  allowedRequests: number;
  retrievedAt: string;
}

/**
 * Blocked/allowed request counts from the admin-only `wafMetrics` query
 * (#673). Returns `null` if the query is unavailable (e.g. before the
 * resolver is deployed) so the banner can degrade gracefully.
 */
export async function fetchWafMetrics(windowHours = 24): Promise<WafMetrics | null> {
  const client = getDataClient();
  const queryFn = (
    client.queries as unknown as {
      wafMetrics?: (
        input: { windowHours?: number },
        opts: typeof USER_POOL,
      ) => Promise<RawOne<unknown>>;
    }
  ).wafMetrics;
  if (!queryFn) return null;
  const res = await queryFn({ windowHours }, USER_POOL);
  throwOnErrors(res, 'fetchWafMetrics');
  const data = res.data;
  if (data == null) return null;
  // The resolver returns a.json(); narrow it defensively.
  const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as Partial<WafMetrics>;
  return {
    webAcl: String(parsed.webAcl ?? ''),
    windowHours: Number(parsed.windowHours ?? windowHours),
    blockedRequests: Number(parsed.blockedRequests ?? 0),
    allowedRequests: Number(parsed.allowedRequests ?? 0),
    retrievedAt: String(parsed.retrievedAt ?? ''),
  };
}
