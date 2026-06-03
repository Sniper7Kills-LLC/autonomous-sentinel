import { describe, it, expect } from 'vitest';
import {
  buildGeoWriteRule,
  buildGeoReadRule,
  extractGeoCodes,
  reconcileRules,
  type GeoRuleConfig,
  type WafRule,
} from './reconcile-webacl';

const cfg: GeoRuleConfig = {
  geoWriteName: 'CountryBlockWrite',
  geoReadName: 'CountryBlockRead',
  geoWritePriority: 10,
  geoReadPriority: 11,
  bannedRegionBodyKey: 'banned-region',
};

const managed: WafRule = { Name: 'AWSCommon', Priority: 0, Statement: {} };
const ipWrite: WafRule = { Name: 'IpBlockWrite', Priority: 20, Statement: {} };

describe('wafSync reconcile-webacl (#199/#201)', () => {
  it('write geo rule is a FLAT AND: country + method-OR + path-OR, plain 403', () => {
    const rule = buildGeoWriteRule(['RU', 'CN'], cfg);
    expect(rule.Name).toBe('CountryBlockWrite');
    expect(rule.Priority).toBe(10);
    expect(rule.Action).toEqual({ Block: {} });
    interface Geo {
      GeoMatchStatement: { CountryCodes: string[] };
    }
    const statement = rule.Statement as {
      AndStatement: { Statements: [Geo, unknown, unknown] };
    };
    const [geo, methodOr, pathOr] = statement.AndStatement.Statements;
    expect(geo.GeoMatchStatement.CountryCodes).toEqual(['RU', 'CN']);
    // write-path conditions are spread in flat — NOT nested under an AndStatement
    expect(methodOr).toHaveProperty('OrStatement');
    expect(pathOr).toHaveProperty('OrStatement');
    expect(methodOr).not.toHaveProperty('AndStatement');
  });

  it('read geo rule matches any request and returns the banned-region body', () => {
    const rule = buildGeoReadRule(['KP'], cfg);
    expect(rule.Statement).toEqual({ GeoMatchStatement: { CountryCodes: ['KP'] } });
    expect(rule.Action).toEqual({
      Block: { CustomResponse: { ResponseCode: 403, CustomResponseBodyKey: 'banned-region' } },
    });
  });

  it('read geo rule uses a plain 403 when bannedRegionBodyKey is null (AppSync ACL)', () => {
    const rule = buildGeoReadRule(['KP'], { ...cfg, bannedRegionBodyKey: null });
    expect(rule.Action).toEqual({ Block: {} });
    expect(rule.Statement).toEqual({ GeoMatchStatement: { CountryCodes: ['KP'] } });
  });

  it('extractGeoCodes reads codes back out, null when the rule is absent', () => {
    const rules = [managed, buildGeoWriteRule(['RU'], cfg)];
    expect(extractGeoCodes(rules, 'CountryBlockWrite')).toEqual(['RU']);
    expect(extractGeoCodes(rules, 'CountryBlockRead')).toBeNull();
  });

  it('reconcileRules preserves static rules and injects only non-empty geo rules', () => {
    const out = reconcileRules([managed, ipWrite], ['RU', 'CN'], ['KP'], cfg);
    expect(out.map((r) => r.Name)).toEqual([
      'AWSCommon',
      'IpBlockWrite',
      'CountryBlockWrite',
      'CountryBlockRead',
    ]);
  });

  it('reconcileRules drops a geo rule when its list is empty', () => {
    const out = reconcileRules([managed], ['RU'], [], cfg);
    expect(out.map((r) => r.Name)).toEqual(['AWSCommon', 'CountryBlockWrite']);
  });

  it('reconcileRules removes stale geo rules from a prior sync (idempotent)', () => {
    const prior = reconcileRules([managed], ['RU'], ['KP'], cfg);
    const next = reconcileRules(prior, [], [], cfg);
    expect(next.map((r) => r.Name)).toEqual(['AWSCommon']);
  });
});
