import { readFileSync } from 'node:fs';
import { type Stack } from 'aws-cdk-lib';
import { CfnWebACL, CfnIPSet, CfnLoggingConfiguration } from 'aws-cdk-lib/aws-wafv2';
import { CfnFunction as CfnCloudFrontFunction } from 'aws-cdk-lib/aws-cloudfront';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { writePathStatementsCdk } from './functions/wafSync/write-path-matcher';

/**
 * AWS WAF in front of CloudFront (#198) + the admin-managed country (#199) and
 * IP CIDR (#200) block rulesets, with the read-vs-write scope split (#201).
 *
 * This module builds the *static* WAF resources. The dynamic contents — which
 * countries / CIDRs are blocked — are reconciled at runtime by the `wafSync`
 * Lambda (`functions/wafSync`), which the ban-table DynamoDB streams trigger:
 *
 *   - Four IPSets (IPv4/IPv6 × write/read) start empty; `wafSync` fills them
 *     via `UpdateIPSet`. The static IP-block rules reference them by ARN, so
 *     their match set changes without a redeploy.
 *   - The two geo (country) rules are NOT defined here — a `GeoMatchStatement`
 *     requires ≥1 country, so an empty one is invalid. `wafSync` injects them
 *     via `UpdateWebACL` only when a country list is non-empty, at the reserved
 *     priorities {@link WAF_RESOURCE_NAMES.geoWritePriority}/`geoReadPriority`.
 *
 * Scope is `CLOUDFRONT` (WAF for CloudFront is global, addressed via us-east-1
 * — already our region). The Web ACL ARN is exported by the caller so the
 * CloudFront distribution Amplify Hosting provisions can be associated with it
 * (that association is an operational step — see amplify/README.md — because
 * Amplify Hosting, not this stack, owns that distribution).
 *
 * Default action is `allow`: public read is free, this is not a deny-by-default
 * site. Three AWS managed rule groups provide baseline protection.
 */

export const WAF_RESOURCE_NAMES = {
  webAcl: 'EamWebAcl',
  ipSets: {
    v4Write: 'EamBanV4Write',
    v4Read: 'EamBanV4Read',
    v6Write: 'EamBanV6Write',
    v6Read: 'EamBanV6Read',
  },
  geoWriteRule: 'CountryBlockWrite',
  geoReadRule: 'CountryBlockRead',
  geoWritePriority: 10,
  geoReadPriority: 11,
  /** Custom-response body key for the self-contained banned page (write blocks). */
  bannedBodyKey: 'banned',
  /** Where read-blocks 302-redirect — the rich per-country page (#202/#689). */
  blockedRedirectPath: '/blocked',
} as const;

/**
 * REGIONAL WAF for the AppSync data API (#687). A separate, minimal Web ACL —
 * CLOUDFRONT-scope resources can't attach to a regional resource. Cost-minimal:
 * default allow + only the read-scope ban enforcement (IP set rule here + a geo
 * read rule injected by wafSync). NO managed rule groups (each adds $/mo;
 * AppSync has its own auth). Only read_write bans reach it.
 */
export const APPSYNC_WAF_NAMES = {
  webAcl: 'EamAppSyncWebAcl',
  ipSets: { v4Read: 'EamAppSyncBanV4Read', v6Read: 'EamAppSyncBanV6Read' },
  ipBlockRule: 'IpBlockRegionalRead',
  ipBlockPriority: 0,
  /** Custom-response body key for the API banned response (JSON). */
  bannedBodyKey: 'banned',
} as const;

/** Self-contained branded banned page (≤4 KB) for website write-blocks (#689). */
const BANNED_PAGE_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Access restricted</title>',
  '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:#0b0f14;color:#d4d4d4;font-family:system-ui,sans-serif;text-align:center}',
  'main{max-width:32rem;padding:2rem}h1{color:#dc2626;font-size:1.25rem;letter-spacing:.04em}',
  'code{color:#9a9a9a}</style></head><body><main>',
  '<h1>ACCESS RESTRICTED</h1>',
  '<p>Your access to this service has been blocked. If you believe this is an error, contact the operators.</p>',
  '<p><code>EAM Watch · WAF</code></p>',
  '</main></body></html>',
].join('');

/** API banned response body (JSON) for AppSync blocks (#689). */
const BANNED_API_JSON = JSON.stringify({
  error: 'FORBIDDEN',
  reason: 'banned',
  message: 'Access to this API has been blocked.',
});

/** wafv2 CDK (camelCase) Block action: redirect (302) or custom 403 body. */
function blockActionCdk(
  spec: { kind: 'redirect'; location: string } | { kind: 'customBody'; bodyKey: string },
) {
  if (spec.kind === 'redirect') {
    return {
      block: {
        customResponse: {
          responseCode: 302,
          responseHeaders: [{ name: 'Location', value: spec.location }],
        },
      },
    };
  }
  return {
    block: { customResponse: { responseCode: 403, customResponseBodyKey: spec.bodyKey } },
  };
}

function ruleVisibility(metricName: string) {
  return {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName,
  };
}

function managedGroupRule(name: string, priority: number): CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
    visibilityConfig: ruleVisibility(name),
  };
}

export interface WafResources {
  webAcl: CfnWebACL;
  ipSets: Record<keyof typeof WAF_RESOURCE_NAMES.ipSets, CfnIPSet>;
  logGroup: LogGroup;
  /** Viewer-request CF function that auto-routes /blocked to the per-country page (#679). */
  blockedGeoRewrite: CfnCloudFrontFunction;
}

export function attachWaf(stack: Stack): WafResources {
  const ipSets = {
    v4Write: new CfnIPSet(stack, 'EamBanV4Write', {
      name: WAF_RESOURCE_NAMES.ipSets.v4Write,
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      addresses: [],
    }),
    v4Read: new CfnIPSet(stack, 'EamBanV4Read', {
      name: WAF_RESOURCE_NAMES.ipSets.v4Read,
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      addresses: [],
    }),
    v6Write: new CfnIPSet(stack, 'EamBanV6Write', {
      name: WAF_RESOURCE_NAMES.ipSets.v6Write,
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV6',
      addresses: [],
    }),
    v6Read: new CfnIPSet(stack, 'EamBanV6Read', {
      name: WAF_RESOURCE_NAMES.ipSets.v6Read,
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV6',
      addresses: [],
    }),
  } as const;

  // Read-blocked visitors may still reach /blocked/* so the banned-region page
  // can render — allow it ABOVE the (runtime-injected) geo block priorities.
  const blockedPageAllowRule: CfnWebACL.RuleProperty = {
    name: 'AllowBlockedRegionPage',
    priority: 5,
    action: { allow: {} },
    statement: {
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: 'STARTS_WITH',
        searchString: '/blocked',
        textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
      },
    },
    visibilityConfig: ruleVisibility('AllowBlockedRegionPage'),
  };

  // IP block — write scope: listed IPs (v4 OR v6 write set) hitting a write
  // surface get the self-contained banned 403 page (#689).
  const ipBlockWriteRule: CfnWebACL.RuleProperty = {
    name: 'IpBlockWrite',
    priority: 20,
    action: blockActionCdk({ kind: 'customBody', bodyKey: WAF_RESOURCE_NAMES.bannedBodyKey }),
    statement: {
      // Flat AND: (v4 OR v6 write IP set) + the two write-path conditions.
      // Spread, not nested — WAF rejects an AndStatement inside an AndStatement.
      andStatement: {
        statements: [
          {
            orStatement: {
              statements: [
                { ipSetReferenceStatement: { arn: ipSets.v4Write.attrArn } },
                { ipSetReferenceStatement: { arn: ipSets.v6Write.attrArn } },
              ],
            },
          },
          ...writePathStatementsCdk(),
        ],
      },
    },
    visibilityConfig: ruleVisibility('IpBlockWrite'),
  };

  // IP block — read scope: listed IPs (v4 OR v6 read set) on ANY request are
  // 302-redirected to the rich /blocked page (#689). The AllowBlockedRegionPage
  // rule (priority 5, above this) keeps /blocked itself reachable — no loop.
  const ipBlockReadRule: CfnWebACL.RuleProperty = {
    name: 'IpBlockRead',
    priority: 21,
    action: blockActionCdk({ kind: 'redirect', location: WAF_RESOURCE_NAMES.blockedRedirectPath }),
    statement: {
      orStatement: {
        statements: [
          { ipSetReferenceStatement: { arn: ipSets.v4Read.attrArn } },
          { ipSetReferenceStatement: { arn: ipSets.v6Read.attrArn } },
        ],
      },
    },
    visibilityConfig: ruleVisibility('IpBlockRead'),
  };

  const webAcl = new CfnWebACL(stack, 'EamWebAcl', {
    name: WAF_RESOURCE_NAMES.webAcl,
    scope: 'CLOUDFRONT',
    defaultAction: { allow: {} },
    visibilityConfig: ruleVisibility('EamWaf'),
    customResponseBodies: {
      [WAF_RESOURCE_NAMES.bannedBodyKey]: {
        contentType: 'TEXT_HTML',
        content: BANNED_PAGE_HTML,
      },
    },
    rules: [
      managedGroupRule('AWSManagedRulesCommonRuleSet', 0),
      managedGroupRule('AWSManagedRulesKnownBadInputsRuleSet', 1),
      managedGroupRule('AWSManagedRulesAmazonIpReputationList', 2),
      blockedPageAllowRule,
      ipBlockWriteRule,
      ipBlockReadRule,
    ],
  });

  // CloudWatch Logs destination — name MUST be `aws-waf-logs-*`. 7-day
  // retention bounds cost (CLAUDE.md cost discipline).
  const logGroup = new LogGroup(stack, 'EamWafLogGroup', {
    logGroupName: 'aws-waf-logs-eam',
    retention: RetentionDays.ONE_WEEK,
  });
  new CfnLoggingConfiguration(stack, 'EamWafLogging', {
    logDestinationConfigs: [logGroup.logGroupArn],
    resourceArn: webAcl.attrArn,
  });

  // Viewer-request CloudFront function (#679): auto-route /blocked to the
  // per-country banned-region page using the CloudFront-Viewer-Country header.
  // The function code is the source-of-truth in cloudfront/blocked-geo-rewrite.js
  // (unit-tested). Like the Web ACL, association to the Amplify-Hosting
  // distribution is a documented operational step — see amplify/README.md.
  const blockedGeoRewrite = new CfnCloudFrontFunction(stack, 'BlockedGeoRewrite', {
    name: 'eam-blocked-geo-rewrite',
    autoPublish: true,
    functionCode: readFileSync(
      new URL('./cloudfront/blocked-geo-rewrite.js', import.meta.url),
      'utf8',
    ),
    functionConfig: {
      comment: 'Auto-route /blocked to per-country banned-region page (#679)',
      runtime: 'cloudfront-js-2.0',
    },
  });

  return { webAcl, ipSets, logGroup, blockedGeoRewrite };
}

export interface AppSyncWafResources {
  webAcl: CfnWebACL;
  ipSets: { v4Read: CfnIPSet; v6Read: CfnIPSet };
}

/**
 * REGIONAL Web ACL for the AppSync data API (#687). Two empty read IPSets
 * (filled by wafSync from the read_write ban rows) + a single block rule that
 * ORs them; a geo read rule is injected at runtime by wafSync. Default allow,
 * no managed rule groups (cost). The association to the AppSync API is created
 * in `backend.ts` (in the data stack, to avoid a WafStack→data CFN cycle).
 */
export function attachAppSyncWaf(stack: Stack): AppSyncWafResources {
  const ipSets = {
    v4Read: new CfnIPSet(stack, 'EamAppSyncBanV4Read', {
      name: APPSYNC_WAF_NAMES.ipSets.v4Read,
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: [],
    }),
    v6Read: new CfnIPSet(stack, 'EamAppSyncBanV6Read', {
      name: APPSYNC_WAF_NAMES.ipSets.v6Read,
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV6',
      addresses: [],
    }),
  } as const;

  const ipBlockRule: CfnWebACL.RuleProperty = {
    name: APPSYNC_WAF_NAMES.ipBlockRule,
    priority: APPSYNC_WAF_NAMES.ipBlockPriority,
    // Banned 403 JSON body (#689) — a 302 redirect would break GraphQL clients.
    action: blockActionCdk({ kind: 'customBody', bodyKey: APPSYNC_WAF_NAMES.bannedBodyKey }),
    statement: {
      orStatement: {
        statements: [
          { ipSetReferenceStatement: { arn: ipSets.v4Read.attrArn } },
          { ipSetReferenceStatement: { arn: ipSets.v6Read.attrArn } },
        ],
      },
    },
    visibilityConfig: ruleVisibility(APPSYNC_WAF_NAMES.ipBlockRule),
  };

  const webAcl = new CfnWebACL(stack, 'EamAppSyncWebAcl', {
    name: APPSYNC_WAF_NAMES.webAcl,
    scope: 'REGIONAL',
    defaultAction: { allow: {} },
    visibilityConfig: ruleVisibility('EamAppSyncWaf'),
    customResponseBodies: {
      [APPSYNC_WAF_NAMES.bannedBodyKey]: {
        contentType: 'APPLICATION_JSON',
        content: BANNED_API_JSON,
      },
    },
    rules: [ipBlockRule],
  });

  return { webAcl, ipSets };
}
