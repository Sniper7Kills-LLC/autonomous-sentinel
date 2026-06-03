/**
 * `wafSync` — reconciles the admin-managed ban lists into live AWS WAF state
 * (#199/#200/#201/#687).
 *
 * Triggered directly by the DynamoDB streams on the `BannedCountry` and
 * `BannedIp` tables (see `amplify/backend.ts`). The stream event is only a
 * wake-up: the handler ignores its contents and performs a full, idempotent
 * reconcile by scanning both (small) tables and projecting them onto:
 *   - the CLOUDFRONT Web ACL (website edge): four IPSets (IPv4/IPv6 ×
 *     write/read) + two runtime geo rules (write + read).
 *   - the REGIONAL Web ACL on the AppSync data API (#687), when configured:
 *     two **read** IPSets (IPv4/IPv6) + one runtime geo **read** rule. Only
 *     `read_write` bans reach AppSync — write-only bans leave the data API open
 *     so a write-blocked visitor can still browse (the front-end reads via
 *     AppSync). Queries vs mutations are indistinguishable at WAF anyway.
 *
 * Idempotent + full-reconcile means concurrent / coalesced invocations all
 * converge on the same end state; the Lambda runs with reserved concurrency 1
 * so the optimistic `LockToken` on `Update*` doesn't thrash.
 *
 * Cycle-safety: reads via the **raw DynamoDB SDK** (Scan), never the Amplify
 * Data client — so no `allow.resource` data→function edge (see backend.ts).
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
export type WafScope = 'CLOUDFRONT' | 'REGIONAL';

export interface IpSetRef {
  /** Which desired-set drives this IPSet's addresses. */
  key: IpSetKey;
  id: string;
  name: string;
  scope: WafScope;
}

/** A Web ACL whose runtime geo rules wafSync reconciles. */
export interface WebAclTarget {
  id: string;
  name: string;
  scope: WafScope;
  cfg: GeoRuleConfig;
  /**
   * Read-scope only (the AppSync regional ACL): inject just the geo **read**
   * rule, never a write geo rule. Write-only bans must not touch AppSync.
   */
  readOnly: boolean;
}

/**
 * The Web ACL fields a reconcile needs. Captured in a single `GetWebACL` so the
 * subsequent `UpdateWebACL` reuses the SAME `LockToken` + metadata.
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
  getWebAcl: (target: WebAclTarget) => Promise<WebAclState>;
  updateWebAcl: (target: WebAclTarget, state: WebAclState, rules: WafRule[]) => Promise<void>;
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

/**
 * IPSets to reconcile: the four CLOUDFRONT sets always; the two REGIONAL read
 * sets (AppSync) only when `APPSYNC_IPSET_V4_READ_ID` is configured. The
 * regional sets mirror the read desired-sets (read_write bans only).
 */
export function ipSetRefs(): IpSetRef[] {
  const refs: IpSetRef[] = [
    {
      key: 'v4Write',
      scope: 'CLOUDFRONT',
      id: requireEnv('IPSET_V4_WRITE_ID'),
      name: requireEnv('IPSET_V4_WRITE_NAME'),
    },
    {
      key: 'v4Read',
      scope: 'CLOUDFRONT',
      id: requireEnv('IPSET_V4_READ_ID'),
      name: requireEnv('IPSET_V4_READ_NAME'),
    },
    {
      key: 'v6Write',
      scope: 'CLOUDFRONT',
      id: requireEnv('IPSET_V6_WRITE_ID'),
      name: requireEnv('IPSET_V6_WRITE_NAME'),
    },
    {
      key: 'v6Read',
      scope: 'CLOUDFRONT',
      id: requireEnv('IPSET_V6_READ_ID'),
      name: requireEnv('IPSET_V6_READ_NAME'),
    },
  ];
  if (process.env.APPSYNC_IPSET_V4_READ_ID) {
    refs.push({
      key: 'v4Read',
      scope: 'REGIONAL',
      id: requireEnv('APPSYNC_IPSET_V4_READ_ID'),
      name: requireEnv('APPSYNC_IPSET_V4_READ_NAME'),
    });
    refs.push({
      key: 'v6Read',
      scope: 'REGIONAL',
      id: requireEnv('APPSYNC_IPSET_V6_READ_ID'),
      name: requireEnv('APPSYNC_IPSET_V6_READ_NAME'),
    });
  }
  return refs;
}

/**
 * Web ACL targets: the CLOUDFRONT website ACL always; the REGIONAL AppSync ACL
 * only when `APPSYNC_WEB_ACL_ID` is configured (read-scope geo only, plain 403
 * block — no banned-region custom response, GraphQL clients don't render HTML).
 */
export function webAclTargets(): WebAclTarget[] {
  const blockedPath = process.env.BLOCKED_REDIRECT_PATH ?? '/blocked';
  const bannedBodyKey = process.env.BANNED_BODY_KEY ?? 'banned';
  const targets: WebAclTarget[] = [
    {
      id: requireEnv('WEB_ACL_ID'),
      name: requireEnv('WEB_ACL_NAME'),
      scope: 'CLOUDFRONT',
      readOnly: false,
      cfg: {
        geoWriteName: process.env.GEO_WRITE_RULE_NAME ?? 'CountryBlockWrite',
        geoReadName: process.env.GEO_READ_RULE_NAME ?? 'CountryBlockRead',
        geoWritePriority: envNumber('GEO_WRITE_PRIORITY', 10),
        geoReadPriority: envNumber('GEO_READ_PRIORITY', 11),
        // Website: reads redirect to the rich /blocked page; writes (API-style)
        // get the self-contained banned 403 body (#689).
        readAction: { kind: 'redirect', location: blockedPath },
        writeAction: { kind: 'customBody', bodyKey: bannedBodyKey },
      },
    },
  ];
  if (process.env.APPSYNC_WEB_ACL_ID) {
    targets.push({
      id: requireEnv('APPSYNC_WEB_ACL_ID'),
      name: requireEnv('APPSYNC_WEB_ACL_NAME'),
      scope: 'REGIONAL',
      readOnly: true,
      cfg: {
        geoWriteName: 'CountryBlockWrite', // unused (readOnly) but required by the type
        geoReadName: process.env.GEO_READ_RULE_NAME ?? 'CountryBlockRead',
        geoWritePriority: envNumber('GEO_WRITE_PRIORITY', 10),
        geoReadPriority: envNumber('GEO_READ_PRIORITY', 11),
        // AppSync (API): a 302 would break GraphQL clients → return the banned
        // 403 body instead. writeAction is unused (readOnly).
        readAction: { kind: 'customBody', bodyKey: bannedBodyKey },
        writeAction: { kind: 'plain' },
      },
    });
  }
  return targets;
}

/** Sorted-membership equality (order-insensitive). */
function sameAddresses(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function sortedEqual(a: string[], b: string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

let cachedDeps: WafSyncDeps | null = null;

function defaultDeps(): WafSyncDeps {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const ddb = new DynamoDBClient({ region });
  // One client for both scopes — CLOUDFRONT WAF is global but addressed via
  // us-east-1, and the AppSync REGIONAL ACL is us-east-1; the Scope arg on each
  // call distinguishes them.
  const waf = new WAFV2Client({ region: 'us-east-1' });

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
        new GetIPSetCommand({ Id: ref.id, Name: ref.name, Scope: ref.scope }),
      );
      return { addresses: res.IPSet?.Addresses ?? [], lockToken: res.LockToken ?? '' };
    },
    updateIpSet: async (ref, addresses, lockToken) => {
      await waf.send(
        new UpdateIPSetCommand({
          Id: ref.id,
          Name: ref.name,
          Scope: ref.scope,
          Addresses: addresses,
          LockToken: lockToken,
        }),
      );
    },
    getWebAcl: async (target) => {
      const res = await waf.send(
        new GetWebACLCommand({ Id: target.id, Name: target.name, Scope: target.scope }),
      );
      return {
        rules: (res.WebACL?.Rules ?? []) as unknown as WafRule[],
        lockToken: res.LockToken ?? '',
        defaultAction: res.WebACL?.DefaultAction ?? { Allow: {} },
        visibilityConfig: res.WebACL?.VisibilityConfig,
        customResponseBodies: res.WebACL?.CustomResponseBodies,
      };
    },
    updateWebAcl: async (target, state, rules) => {
      await waf.send(
        new UpdateWebACLCommand({
          Id: target.id,
          Name: target.name,
          Scope: target.scope,
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

export interface IpSetResult {
  key: IpSetKey;
  scope: WafScope;
  changed: boolean;
}

export async function reconcileIpSets(
  deps: WafSyncDeps,
  desired: DesiredIpSets,
): Promise<IpSetResult[]> {
  const results: IpSetResult[] = [];
  for (const ref of ipSetRefs()) {
    const want = desired[ref.key];
    const current = await deps.getIpSet(ref);
    if (sameAddresses(current.addresses, want)) {
      results.push({ key: ref.key, scope: ref.scope, changed: false });
      continue;
    }
    await deps.updateIpSet(ref, want, current.lockToken);
    results.push({ key: ref.key, scope: ref.scope, changed: true });
  }
  return results;
}

export async function reconcileWebAcl(
  deps: WafSyncDeps,
  target: WebAclTarget,
  desired: DesiredCountries,
): Promise<{ changed: boolean }> {
  const cfg = target.cfg;
  const acl = await deps.getWebAcl(target);

  // Read-only (AppSync) targets never carry a write geo rule.
  const wantWrite = target.readOnly ? [] : desired.write;
  const wantRead = desired.read;
  const currentWrite = target.readOnly ? [] : (extractGeoCodes(acl.rules, cfg.geoWriteName) ?? []);
  const currentRead = extractGeoCodes(acl.rules, cfg.geoReadName) ?? [];

  if (sortedEqual(currentWrite, wantWrite) && sortedEqual(currentRead, wantRead)) {
    return { changed: false };
  }

  const rules = reconcileRules(acl.rules, wantWrite, wantRead, cfg);
  await deps.updateWebAcl(target, acl, rules);
  return { changed: true };
}

export interface WafSyncSummary {
  ipSets: IpSetResult[];
  webAcls: { scope: WafScope; changed: boolean }[];
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
  const webAcls: { scope: WafScope; changed: boolean }[] = [];
  for (const target of webAclTargets()) {
    const r = await reconcileWebAcl(deps, target, desiredCountries);
    webAcls.push({ scope: target.scope, changed: r.changed });
  }

  const summary: WafSyncSummary = { ipSets, webAcls };
  console.info('wafSync reconcile complete', JSON.stringify(summary));
  return summary;
};
