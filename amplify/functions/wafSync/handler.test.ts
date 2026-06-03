import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DynamoDBStreamEvent, Context } from 'aws-lambda';
import {
  handler,
  reconcileIpSets,
  reconcileWebAcl,
  __setDeps,
  __resetDeps,
  type WafSyncDeps,
  type WebAclTarget,
} from './handler';
import { buildGeoWriteRule, type WafRule, type GeoRuleConfig } from './reconcile-webacl';

const BASE_ENV: Record<string, string> = {
  WEB_ACL_ID: 'acl-id',
  WEB_ACL_NAME: 'EamWebAcl',
  IPSET_V4_WRITE_ID: 'v4w-id',
  IPSET_V4_WRITE_NAME: 'v4w',
  IPSET_V4_READ_ID: 'v4r-id',
  IPSET_V4_READ_NAME: 'v4r',
  IPSET_V6_WRITE_ID: 'v6w-id',
  IPSET_V6_WRITE_NAME: 'v6w',
  IPSET_V6_READ_ID: 'v6r-id',
  IPSET_V6_READ_NAME: 'v6r',
};

const APPSYNC_ENV: Record<string, string> = {
  APPSYNC_WEB_ACL_ID: 'racl-id',
  APPSYNC_WEB_ACL_NAME: 'EamAppSyncWebAcl',
  APPSYNC_IPSET_V4_READ_ID: 'rv4r-id',
  APPSYNC_IPSET_V4_READ_NAME: 'rv4r',
  APPSYNC_IPSET_V6_READ_ID: 'rv6r-id',
  APPSYNC_IPSET_V6_READ_NAME: 'rv6r',
};

const geoCfg: GeoRuleConfig = {
  geoWriteName: 'CountryBlockWrite',
  geoReadName: 'CountryBlockRead',
  geoWritePriority: 10,
  geoReadPriority: 11,
  readAction: { kind: 'redirect', location: '/blocked' },
  writeAction: { kind: 'customBody', bodyKey: 'banned' },
};

const cfTarget: WebAclTarget = {
  id: 'acl-id',
  name: 'EamWebAcl',
  scope: 'CLOUDFRONT',
  readOnly: false,
  cfg: geoCfg,
};

const event = {} as DynamoDBStreamEvent;
const context = {} as Context;
const cb = () => undefined;

function aclState(rules: WafRule[] = []) {
  return {
    rules,
    lockToken: 'acl-lock',
    defaultAction: { Allow: {} },
    visibilityConfig: {},
    customResponseBodies: {},
  };
}

function makeDeps(over: Partial<WafSyncDeps> = {}): {
  deps: WafSyncDeps;
  ipUpdates: Record<string, string[]>;
  aclUpdates: { scope: string; rules: WafRule[] }[];
} {
  const ipUpdates: Record<string, string[]> = {};
  const aclUpdates: { scope: string; rules: WafRule[] }[] = [];
  const deps: WafSyncDeps = {
    scanBannedIps: vi.fn<WafSyncDeps['scanBannedIps']>(() => Promise.resolve([])),
    scanBannedCountries: vi.fn<WafSyncDeps['scanBannedCountries']>(() => Promise.resolve([])),
    getIpSet: vi.fn<WafSyncDeps['getIpSet']>((ref) =>
      Promise.resolve({ addresses: [], lockToken: `lock-${ref.scope}-${ref.key}` }),
    ),
    updateIpSet: vi.fn<WafSyncDeps['updateIpSet']>((ref, addresses) => {
      ipUpdates[`${ref.scope}:${ref.key}`] = addresses;
      return Promise.resolve();
    }),
    getWebAcl: vi.fn<WafSyncDeps['getWebAcl']>(() => Promise.resolve(aclState())),
    updateWebAcl: vi.fn<WafSyncDeps['updateWebAcl']>((target, _state, rules) => {
      aclUpdates.push({ scope: target.scope, rules });
      return Promise.resolve();
    }),
    now: () => Date.parse('2026-06-02T00:00:00Z'),
    ...over,
  };
  return { deps, ipUpdates, aclUpdates };
}

describe('wafSync handler (#199/#200/#201/#687)', () => {
  beforeEach(() => {
    Object.assign(process.env, BASE_ENV);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    __resetDeps();
    for (const k of [...Object.keys(BASE_ENV), ...Object.keys(APPSYNC_ENV)]) delete process.env[k];
    vi.restoreAllMocks();
  });

  describe('reconcileIpSets', () => {
    it('updates only the sets whose addresses changed (CLOUDFRONT only by default)', async () => {
      const { deps, ipUpdates } = makeDeps({
        getIpSet: vi.fn<WafSyncDeps['getIpSet']>((ref) =>
          Promise.resolve({
            addresses: ref.key === 'v4Write' ? ['203.0.113.0/24'] : [],
            lockToken: 'lk',
          }),
        ),
      });
      const results = await reconcileIpSets(deps, {
        v4Write: ['203.0.113.0/24'],
        v4Read: [],
        v6Write: ['2001:db8::/32'],
        v6Read: [],
      });
      expect(results).toHaveLength(4); // no APPSYNC env → CF sets only
      expect(results.find((r) => r.key === 'v4Write')?.changed).toBe(false);
      expect(results.find((r) => r.key === 'v6Write')?.changed).toBe(true);
      expect(ipUpdates).toEqual({ 'CLOUDFRONT:v6Write': ['2001:db8::/32'] });
    });

    it('also reconciles the two REGIONAL read sets when APPSYNC env is present', async () => {
      Object.assign(process.env, APPSYNC_ENV);
      const { deps, ipUpdates } = makeDeps();
      const results = await reconcileIpSets(deps, {
        v4Write: ['203.0.113.0/24'],
        v4Read: ['203.0.113.0/24'],
        v6Write: [],
        v6Read: [],
      });
      expect(results).toHaveLength(6); // 4 CF + 2 regional read
      // regional v4Read mirrors the read desired-set; regional v6Read stays empty
      expect(ipUpdates['REGIONAL:v4Read']).toEqual(['203.0.113.0/24']);
      expect(ipUpdates['REGIONAL:v6Read']).toBeUndefined();
    });
  });

  describe('reconcileWebAcl', () => {
    it('skips UpdateWebACL when the live country codes already match', async () => {
      const existing = [buildGeoWriteRule(['RU'], geoCfg)];
      const { deps, aclUpdates } = makeDeps({
        getWebAcl: vi.fn<WafSyncDeps['getWebAcl']>(() => Promise.resolve(aclState(existing))),
      });
      const res = await reconcileWebAcl(deps, cfTarget, { write: ['RU'], read: [] });
      expect(res.changed).toBe(false);
      expect(aclUpdates).toHaveLength(0);
      expect(deps.getWebAcl).toHaveBeenCalledTimes(1);
    });

    it('updates the CLOUDFRONT ACL with write + read geo rules', async () => {
      const { deps, aclUpdates } = makeDeps();
      const res = await reconcileWebAcl(deps, cfTarget, { write: ['RU', 'CN'], read: ['KP'] });
      expect(res.changed).toBe(true);
      expect(aclUpdates[0]!.rules.map((r) => r.Name)).toEqual([
        'CountryBlockWrite',
        'CountryBlockRead',
      ]);
    });

    it('read-only (AppSync) target injects ONLY the read geo rule, ignoring write codes', async () => {
      const regionalTarget: WebAclTarget = {
        id: 'racl-id',
        name: 'EamAppSyncWebAcl',
        scope: 'REGIONAL',
        readOnly: true,
        cfg: { ...geoCfg, readAction: { kind: 'customBody', bodyKey: 'banned' } },
      };
      const { deps, aclUpdates } = makeDeps();
      const res = await reconcileWebAcl(deps, regionalTarget, {
        write: ['RU', 'CN'],
        read: ['KP'],
      });
      expect(res.changed).toBe(true);
      // no CountryBlockWrite — write-only bans never reach AppSync
      expect(aclUpdates[0]!.rules.map((r) => r.Name)).toEqual(['CountryBlockRead']);
    });
  });

  describe('full reconcile', () => {
    it('CLOUDFRONT only by default: 4 IP sets + 1 web ACL', async () => {
      const { deps, ipUpdates, aclUpdates } = makeDeps({
        scanBannedIps: vi.fn<WafSyncDeps['scanBannedIps']>(() =>
          Promise.resolve([
            { cidr: '203.0.113.0/24', scope: 'read_write' },
            { cidr: '198.51.100.5/32', scope: 'write' },
          ]),
        ),
        scanBannedCountries: vi.fn<WafSyncDeps['scanBannedCountries']>(() =>
          Promise.resolve([
            { iso2: 'ru', scope: 'read_write' },
            { iso2: 'cn', scope: 'write' },
          ]),
        ),
      });
      __setDeps(deps);
      const summary = await handler(event, context, cb);

      expect(ipUpdates['CLOUDFRONT:v4Write']?.sort()).toEqual([
        '198.51.100.5/32',
        '203.0.113.0/24',
      ]);
      expect(ipUpdates['CLOUDFRONT:v4Read']).toEqual(['203.0.113.0/24']);
      expect(aclUpdates[0]!.rules.map((r) => r.Name)).toEqual([
        'CountryBlockWrite',
        'CountryBlockRead',
      ]);
      expect(summary.ipSets).toHaveLength(4);
      expect(summary.webAcls).toEqual([{ scope: 'CLOUDFRONT', changed: true }]);
    });

    it('with APPSYNC env: also blocks read_write bans on the regional ACL (read-only)', async () => {
      Object.assign(process.env, APPSYNC_ENV);
      const { deps, ipUpdates, aclUpdates } = makeDeps({
        scanBannedIps: vi.fn<WafSyncDeps['scanBannedIps']>(() =>
          Promise.resolve([
            { cidr: '203.0.113.0/24', scope: 'read_write' },
            { cidr: '198.51.100.5/32', scope: 'write' },
          ]),
        ),
        scanBannedCountries: vi.fn<WafSyncDeps['scanBannedCountries']>(() =>
          Promise.resolve([{ iso2: 'ru', scope: 'read_write' }]),
        ),
      });
      __setDeps(deps);
      const summary = await handler(event, context, cb);

      expect(summary.ipSets).toHaveLength(6);
      expect(summary.webAcls).toEqual([
        { scope: 'CLOUDFRONT', changed: true },
        { scope: 'REGIONAL', changed: true },
      ]);
      // regional read set gets ONLY the read_write CIDR (write-only excluded)
      expect(ipUpdates['REGIONAL:v4Read']).toEqual(['203.0.113.0/24']);
      // regional ACL: read geo rule only
      const regionalUpdate = aclUpdates.find((u) => u.scope === 'REGIONAL');
      expect(regionalUpdate?.rules.map((r) => r.Name)).toEqual(['CountryBlockRead']);
    });

    it('clears everything when both tables are empty', async () => {
      const { deps, ipUpdates, aclUpdates } = makeDeps({
        getWebAcl: vi.fn<WafSyncDeps['getWebAcl']>(() =>
          Promise.resolve(aclState([buildGeoWriteRule(['RU'], geoCfg)])),
        ),
      });
      __setDeps(deps);
      await handler(event, context, cb);
      expect(aclUpdates[0]!.rules.map((r) => r.Name)).toEqual([]);
      expect(ipUpdates).toEqual({});
    });
  });
});
