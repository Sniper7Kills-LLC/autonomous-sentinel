/**
 * `wafSync` — reconciles the admin-managed ban lists into live AWS WAF state
 * (#199/#200/#201).
 *
 * Triggered directly by the DynamoDB streams on the `BannedCountry` and
 * `BannedIp` tables (see `amplify/backend.ts`). The stream event is only a
 * wake-up: the handler ignores its contents and performs a full, idempotent
 * reconcile by scanning both (small) tables and projecting them onto:
 *   - four WAF IPSets — IPv4/IPv6 × write/read — via `UpdateIPSet`
 *   - the two runtime-injected geo rules on the Web ACL — via `UpdateWebACL`
 *
 * Idempotent + full-reconcile means concurrent / coalesced invocations all
 * converge on the same end state; the Lambda runs with reserved concurrency 1
 * so the optimistic `LockToken` on `Update*` doesn't thrash.
 *
 * Cycle-safety: reads via the **raw DynamoDB SDK** (Scan), never the Amplify
 * Data client, so there is no `allow.resource` edge from the data stack back to
 * this function — the only cross-stack edges are this function → {data tables /
 * streams, WAF resources}, all one-directional (see the design note in
 * `backend.ts`).
 */

import type { DynamoDBStreamEvent, Context, Callback } from 'aws-lambda';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  WAFV2Client,
  GetIPSetCommand,
  UpdateIPSetCommand,
  GetWebACLCommand,
  UpdateWebACLCommand,
} from '@aws-sdk/client-wafv2';
import {
  computeDesiredCountries,
  computeDesiredIpSets,
  type BannedCountryRow,
  type BannedIpRow,
  type DesiredCountries,
  type DesiredIpSets,
} from './desired-state';
import {
  extractGeoCodes,
  reconcileRules,
  type GeoRuleConfig,
  type WafRule,
} from './reconcile-webacl';

type IpSetKey = keyof DesiredIpSets; // 'v4Write' | 'v4Read' | 'v6Write' | 'v6Read'

interface IpSetRef {
  key: IpSetKey;
  id: string;
  name: string;
}

/**
 * The Web ACL fields a reconcile needs. Captured in a single `GetWebACL` so the
 * subsequent `UpdateWebACL` reuses the SAME `LockToken` + metadata — no second
 * Get (which would burn a WAF API call and reuse a token fetched at a different
 * moment than the metadata it pairs with).
 */
export interface WebAclState {
  rules: WafRule[];
  lockToken: string;
  defaultAction: unknown;
  visibilityConfig: unknown;
  customResponseBodies: unknown;
}

export interface WafSyncDeps {
  scanBannedIps: () => Promise<BannedIpRow[]>;
  scanBannedCountries: () => Promise<BannedCountryRow[]>;
  getIpSet: (ref: IpSetRef) => Promise<{ addresses: string[]; lockToken: string }>;
  updateIpSet: (ref: IpSetRef, addresses: string[], lockToken: string) => Promise<void>;
  getWebAcl: () => Promise<WebAclState>;
  updateWebAcl: (state: WebAclState, rules: WafRule[]) => Promise<void>;
  now: () => number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`wafSync: missing required env var ${name}`);
  return value;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`wafSync: invalid integer env var ${name}='${raw}'`);
  }
  return n;
}

export function ipSetRefs(): IpSetRef[] {
  return [
    {
      key: 'v4Write',
      id: requireEnv('IPSET_V4_WRITE_ID'),
      name: requireEnv('IPSET_V4_WRITE_NAME'),
    },
    { key: 'v4Read', id: requireEnv('IPSET_V4_READ_ID'), name: requireEnv('IPSET_V4_READ_NAME') },
    {
      key: 'v6Write',
      id: requireEnv('IPSET_V6_WRITE_ID'),
      name: requireEnv('IPSET_V6_WRITE_NAME'),
    },
    { key: 'v6Read', id: requireEnv('IPSET_V6_READ_ID'), name: requireEnv('IPSET_V6_READ_NAME') },
  ];
}

export function geoRuleConfig(): GeoRuleConfig {
  return {
    geoWriteName: process.env.GEO_WRITE_RULE_NAME ?? 'CountryBlockWrite',
    geoReadName: process.env.GEO_READ_RULE_NAME ?? 'CountryBlockRead',
    geoWritePriority: envNumber('GEO_WRITE_PRIORITY', 10),
    geoReadPriority: envNumber('GEO_READ_PRIORITY', 11),
    bannedRegionBodyKey: process.env.BANNED_REGION_BODY_KEY ?? 'banned-region',
  };
}

/** Sorted-membership equality (order-insensitive). */
function sameAddresses(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

let cachedDeps: WafSyncDeps | null = null;

function defaultDeps(): WafSyncDeps {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const ddb = new DynamoDBClient({ region });
  // WAF for CLOUDFRONT scope is a global service addressed via us-east-1.
  const waf = new WAFV2Client({ region: 'us-east-1' });
  const scope = process.env.WEB_ACL_SCOPE ?? 'CLOUDFRONT';

  async function scanAll<T>(table: string): Promise<T[]> {
    const rows: T[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new ScanCommand({ TableName: table, ExclusiveStartKey: lastKey as never }),
      );
      for (const item of res.Items ?? []) rows.push(unmarshall(item) as T);
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return rows;
  }

  return {
    scanBannedIps: () => scanAll<BannedIpRow>(requireEnv('BANNED_IP_TABLE')),
    scanBannedCountries: () => scanAll<BannedCountryRow>(requireEnv('BANNED_COUNTRY_TABLE')),
    getIpSet: async (ref) => {
      const res = await waf.send(
        new GetIPSetCommand({ Id: ref.id, Name: ref.name, Scope: scope as never }),
      );
      return {
        addresses: res.IPSet?.Addresses ?? [],
        lockToken: res.LockToken ?? '',
      };
    },
    updateIpSet: async (ref, addresses, lockToken) => {
      await waf.send(
        new UpdateIPSetCommand({
          Id: ref.id,
          Name: ref.name,
          Scope: scope as never,
          Addresses: addresses,
          LockToken: lockToken,
        }),
      );
    },
    getWebAcl: async () => {
      const res = await waf.send(
        new GetWebACLCommand({
          Id: requireEnv('WEB_ACL_ID'),
          Name: requireEnv('WEB_ACL_NAME'),
          Scope: scope as never,
        }),
      );
      return {
        rules: (res.WebACL?.Rules ?? []) as unknown as WafRule[],
        lockToken: res.LockToken ?? '',
        defaultAction: res.WebACL?.DefaultAction ?? { Allow: {} },
        visibilityConfig: res.WebACL?.VisibilityConfig,
        customResponseBodies: res.WebACL?.CustomResponseBodies,
      };
    },
    updateWebAcl: async (state, rules) => {
      await waf.send(
        new UpdateWebACLCommand({
          Id: requireEnv('WEB_ACL_ID'),
          Name: requireEnv('WEB_ACL_NAME'),
          Scope: scope as never,
          DefaultAction: state.defaultAction as never,
          VisibilityConfig: state.visibilityConfig as never,
          CustomResponseBodies: state.customResponseBodies as never,
          Rules: rules as never,
          LockToken: state.lockToken,
        }),
      );
    },
    now: () => Date.now(),
  };
}

function activeDeps(): WafSyncDeps {
  if (!cachedDeps) cachedDeps = defaultDeps();
  return cachedDeps;
}

/** Test seam. */
export function __setDeps(deps: WafSyncDeps): void {
  cachedDeps = deps;
}
export function __resetDeps(): void {
  cachedDeps = null;
}

export async function reconcileIpSets(
  deps: WafSyncDeps,
  desired: DesiredIpSets,
): Promise<{ key: IpSetKey; changed: boolean }[]> {
  const results: { key: IpSetKey; changed: boolean }[] = [];
  for (const ref of ipSetRefs()) {
    const want = desired[ref.key];
    const current = await deps.getIpSet(ref);
    if (sameAddresses(current.addresses, want)) {
      results.push({ key: ref.key, changed: false });
      continue;
    }
    await deps.updateIpSet(ref, want, current.lockToken);
    results.push({ key: ref.key, changed: true });
  }
  return results;
}

export async function reconcileWebAcl(
  deps: WafSyncDeps,
  desired: DesiredCountries,
): Promise<{ changed: boolean }> {
  const cfg = geoRuleConfig();
  const acl = await deps.getWebAcl();
  const currentWrite = (extractGeoCodes(acl.rules, cfg.geoWriteName) ?? []).slice().sort();
  const currentRead = (extractGeoCodes(acl.rules, cfg.geoReadName) ?? []).slice().sort();
  const wantWrite = desired.write.slice().sort();
  const wantRead = desired.read.slice().sort();

  const unchanged =
    currentWrite.length === wantWrite.length &&
    currentWrite.every((v, i) => v === wantWrite[i]) &&
    currentRead.length === wantRead.length &&
    currentRead.every((v, i) => v === wantRead[i]);

  if (unchanged) return { changed: false };

  const rules = reconcileRules(acl.rules, desired.write, desired.read, cfg);
  await deps.updateWebAcl(acl, rules);
  return { changed: true };
}

export interface WafSyncSummary {
  ipSets: { key: IpSetKey; changed: boolean }[];
  webAclChanged: boolean;
}

export const handler = async (
  _event: DynamoDBStreamEvent,
  _context?: Context,
  _callback?: Callback,
): Promise<WafSyncSummary> => {
  const deps = activeDeps();
  const nowMs = deps.now();
  const [ipRows, countryRows] = await Promise.all([
    deps.scanBannedIps(),
    deps.scanBannedCountries(),
  ]);
  const desiredIp = computeDesiredIpSets(ipRows, nowMs);
  const desiredCountries = computeDesiredCountries(countryRows);

  const ipSets = await reconcileIpSets(deps, desiredIp);
  const webAcl = await reconcileWebAcl(deps, desiredCountries);

  const summary: WafSyncSummary = { ipSets, webAclChanged: webAcl.changed };
  console.info('wafSync reconcile complete', JSON.stringify(summary));
  return summary;
};
