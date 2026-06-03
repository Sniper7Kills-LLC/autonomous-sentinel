import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DynamoDBStreamEvent, Context } from 'aws-lambda';
import {
  handler,
  reconcileIpSets,
  reconcileWebAcl,
  __setDeps,
  __resetDeps,
  type WafSyncDeps,
} from './handler';
import { buildGeoWriteRule, type WafRule } from './reconcile-webacl';

const IPSET_ENV: Record<string, string> = {
  IPSET_V4_WRITE_ID: 'v4w-id',
  IPSET_V4_WRITE_NAME: 'v4w',
  IPSET_V4_READ_ID: 'v4r-id',
  IPSET_V4_READ_NAME: 'v4r',
  IPSET_V6_WRITE_ID: 'v6w-id',
  IPSET_V6_WRITE_NAME: 'v6w',
  IPSET_V6_READ_ID: 'v6r-id',
  IPSET_V6_READ_NAME: 'v6r',
};

const geoCfg = {
  geoWriteName: 'CountryBlockWrite',
  geoReadName: 'CountryBlockRead',
  geoWritePriority: 10,
  geoReadPriority: 11,
  bannedRegionBodyKey: 'banned-region',
};

const event = {} as DynamoDBStreamEvent;
const context = {} as Context;
const cb = () => undefined;

/** A complete WebAclState double — getWebAcl captures everything in one call. */
function aclState(rules: WafRule[] = []) {
  return {
    rules,
    lockToken: 'acl-lock',
    defaultAction: { Allow: {} },
    visibilityConfig: {},
    customResponseBodies: {},
  };
}

/** A deps double with in-memory IPSet + Web ACL state and call spies. */
function makeDeps(over: Partial<WafSyncDeps> = {}): {
  deps: WafSyncDeps;
  ipUpdates: Record<string, string[]>;
  aclUpdates: WafRule[][];
} {
  const ipUpdates: Record<string, string[]> = {};
  const aclUpdates: WafRule[][] = [];
  const deps: WafSyncDeps = {
    scanBannedIps: vi.fn<WafSyncDeps['scanBannedIps']>(() => Promise.resolve([])),
    scanBannedCountries: vi.fn<WafSyncDeps['scanBannedCountries']>(() => Promise.resolve([])),
    getIpSet: vi.fn<WafSyncDeps['getIpSet']>((ref) =>
      Promise.resolve({ addresses: [], lockToken: `lock-${ref.key}` }),
    ),
    updateIpSet: vi.fn<WafSyncDeps['updateIpSet']>((ref, addresses) => {
      ipUpdates[ref.key] = addresses;
      return Promise.resolve();
    }),
    getWebAcl: vi.fn<WafSyncDeps['getWebAcl']>(() => Promise.resolve(aclState())),
    updateWebAcl: vi.fn<WafSyncDeps['updateWebAcl']>((_state, rules) => {
      aclUpdates.push(rules);
      return Promise.resolve();
    }),
    now: () => Date.parse('2026-06-02T00:00:00Z'),
    ...over,
  };
  return { deps, ipUpdates, aclUpdates };
}

describe('wafSync handler (#199/#200/#201)', () => {
  beforeEach(() => {
    Object.assign(process.env, IPSET_ENV);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    __resetDeps();
    for (const k of Object.keys(IPSET_ENV)) delete process.env[k];
    vi.restoreAllMocks();
  });

  describe('reconcileIpSets', () => {
    it('updates only the sets whose addresses changed', async () => {
      const { deps, ipUpdates } = makeDeps({
        getIpSet: vi.fn<WafSyncDeps['getIpSet']>((ref) =>
          // v4Write already has the target; the rest are empty
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
      // v4Write unchanged (skip), v6Write changed (update), reads unchanged
      expect(results.find((r) => r.key === 'v4Write')?.changed).toBe(false);
      expect(results.find((r) => r.key === 'v6Write')?.changed).toBe(true);
      expect(ipUpdates).toEqual({ v6Write: ['2001:db8::/32'] });
    });
  });

  describe('reconcileWebAcl', () => {
    it('skips UpdateWebACL when the live country codes already match', async () => {
      const existing = [buildGeoWriteRule(['RU'], geoCfg)];
      const { deps, aclUpdates } = makeDeps({
        getWebAcl: vi.fn<WafSyncDeps['getWebAcl']>(() => Promise.resolve(aclState(existing))),
      });
      const res = await reconcileWebAcl(deps, { write: ['RU'], read: [] });
      expect(res.changed).toBe(false);
      expect(aclUpdates).toHaveLength(0);
      // single Get — no redundant second fetch inside updateWebAcl
      expect(deps.getWebAcl).toHaveBeenCalledTimes(1);
    });

    it('updates when the desired country codes differ', async () => {
      const { deps, aclUpdates } = makeDeps();
      const res = await reconcileWebAcl(deps, { write: ['RU', 'CN'], read: ['KP'] });
      expect(res.changed).toBe(true);
      expect(aclUpdates).toHaveLength(1);
      expect(aclUpdates[0]!.map((r) => r.Name)).toEqual(['CountryBlockWrite', 'CountryBlockRead']);
    });
  });

  describe('full reconcile', () => {
    it('projects scanned rows onto IP sets + geo rules', async () => {
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

      // read_write CIDR lands in both write+read v4 sets; write-only only in write
      expect(ipUpdates.v4Write?.sort()).toEqual(['198.51.100.5/32', '203.0.113.0/24']);
      expect(ipUpdates.v4Read).toEqual(['203.0.113.0/24']);
      // countries: write list = both, read list = read_write only
      expect(aclUpdates[0]!.map((r) => r.Name)).toEqual(['CountryBlockWrite', 'CountryBlockRead']);
      expect(summary.webAclChanged).toBe(true);
      expect(summary.ipSets).toHaveLength(4);
    });

    it('clears everything when both tables are empty (no rules, empty sets)', async () => {
      const { deps, ipUpdates, aclUpdates } = makeDeps({
        getWebAcl: vi.fn<WafSyncDeps['getWebAcl']>(() =>
          Promise.resolve(aclState([buildGeoWriteRule(['RU'], geoCfg)])),
        ),
      });
      __setDeps(deps);
      await handler(event, context, cb);
      // geo rule removed → UpdateWebACL with no geo rules
      expect(aclUpdates[0]!.map((r) => r.Name)).toEqual([]);
      // no IP updates needed (already empty)
      expect(ipUpdates).toEqual({});
    });
  });
});
