/**
 * Pure Web ACL rule reconciliation for the geo (country) block (#199/#201).
 *
 * Country blocks can't live in a WAF IPSet, and a `GeoMatchStatement` requires
 * at least one country code — so an "empty" geo rule is invalid and must be
 * *absent* rather than present-with-zero-codes. We therefore keep the geo
 * rules OUT of the static CDK Web ACL and let `wafSync` inject/remove them at
 * runtime via `UpdateWebACL`:
 *
 *   - `reconcileRules` strips any existing geo rules (by name), then re-adds a
 *     write geo rule iff there are write-scope countries and a read geo rule
 *     iff there are read-scope countries. All other rules (the AWS managed
 *     groups + the static IP-block rules) pass through untouched.
 *   - `extractGeoCodes` reads the current country list back out of a Web ACL's
 *     rules so the handler can skip a no-op `UpdateWebACL` (which would burn the
 *     optimistic LockToken and risk needless throttling).
 *
 * Everything here operates on the wafv2 **SDK** (PascalCase) rule shape, the
 * same shape `GetWebACL` returns and `UpdateWebACL` expects.
 */

import { writePathStatements } from './write-path-matcher';

export interface WafRule {
  Name: string;
  Priority: number;
  [key: string]: unknown;
}

export interface GeoRuleConfig {
  /** Rule name for the write-scope geo block. */
  geoWriteName: string;
  /** Rule name for the read-scope geo block. */
  geoReadName: string;
  /** WAF rule priority for the write geo rule (must be unique in the ACL). */
  geoWritePriority: number;
  /** WAF rule priority for the read geo rule (must be unique in the ACL). */
  geoReadPriority: number;
  /**
   * Custom-response body key for read-blocked traffic (the banned-region stub on
   * the CLOUDFRONT website ACL). `null` → a plain 403 block with no custom
   * response (the REGIONAL AppSync ACL, whose clients don't render HTML and
   * which doesn't define that response body).
   */
  bannedRegionBodyKey: string | null;
}

function visibility(metricName: string) {
  return {
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: metricName,
  };
}

/**
 * Write-scope geo block: country matches AND the request targets a write
 * surface. Plain 403 — write blocks don't render the banned-region page.
 */
export function buildGeoWriteRule(codes: string[], cfg: GeoRuleConfig): WafRule {
  return {
    Name: cfg.geoWriteName,
    Priority: cfg.geoWritePriority,
    Action: { Block: {} },
    Statement: {
      // Flat AND: country match + the two write-path conditions. The write-path
      // conditions are spread (not nested) — WAF forbids AND-inside-AND.
      AndStatement: {
        Statements: [{ GeoMatchStatement: { CountryCodes: codes } }, ...writePathStatements()],
      },
    },
    VisibilityConfig: visibility(cfg.geoWriteName),
  };
}

/**
 * Read-scope geo block: country matches on any request → 403. On the website
 * ACL (`bannedRegionBodyKey` set) it returns the banned-region custom response
 * (the #202 landing page); on the AppSync ACL (`bannedRegionBodyKey: null`) a
 * plain 403.
 */
export function buildGeoReadRule(codes: string[], cfg: GeoRuleConfig): WafRule {
  const action = cfg.bannedRegionBodyKey
    ? {
        Block: {
          CustomResponse: { ResponseCode: 403, CustomResponseBodyKey: cfg.bannedRegionBodyKey },
        },
      }
    : { Block: {} };
  return {
    Name: cfg.geoReadName,
    Priority: cfg.geoReadPriority,
    Action: action,
    Statement: { GeoMatchStatement: { CountryCodes: codes } },
    VisibilityConfig: visibility(cfg.geoReadName),
  };
}

/** Deep-find the first `GeoMatchStatement.CountryCodes` inside a rule. */
function findCountryCodes(node: unknown): string[] | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const geo = obj.GeoMatchStatement as { CountryCodes?: unknown } | undefined;
  if (geo && Array.isArray(geo.CountryCodes)) {
    return geo.CountryCodes.map(String);
  }
  for (const value of Object.values(obj)) {
    const found = findCountryCodes(value);
    if (found) return found;
  }
  return null;
}

/**
 * Read the country codes currently configured on the named geo rule, or `null`
 * when the rule is absent. Lets the handler diff current vs desired and skip a
 * no-op `UpdateWebACL`.
 */
export function extractGeoCodes(rules: WafRule[], ruleName: string): string[] | null {
  const rule = rules.find((r) => r.Name === ruleName);
  if (!rule) return null;
  return findCountryCodes(rule);
}

/**
 * Rebuild the ACL rule list: drop the two geo rules, then re-add each only when
 * its country list is non-empty. Static rules (managed groups, IP blocks) are
 * preserved verbatim and in order.
 */
export function reconcileRules(
  currentRules: WafRule[],
  writeCodes: string[],
  readCodes: string[],
  cfg: GeoRuleConfig,
): WafRule[] {
  const preserved = currentRules.filter(
    (r) => r.Name !== cfg.geoWriteName && r.Name !== cfg.geoReadName,
  );
  const rebuilt = [...preserved];
  if (writeCodes.length > 0) rebuilt.push(buildGeoWriteRule(writeCodes, cfg));
  if (readCodes.length > 0) rebuilt.push(buildGeoReadRule(readCodes, cfg));
  return rebuilt;
}
