import { type Stack } from 'aws-cdk-lib';
import { CfnWebACL, CfnIPSet, CfnLoggingConfiguration } from 'aws-cdk-lib/aws-wafv2';
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
  bannedRegionBodyKey: 'banned-region',
} as const;

/** Tiny meta-refresh stub returned on read-blocked traffic → the #202 page. */
const BANNED_REGION_BODY = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="robots" content="noindex">',
  '<meta http-equiv="refresh" content="0; url=/blocked">',
  '<title>Access restricted</title></head>',
  '<body>Access from your region is restricted. <a href="/blocked">Details</a>.</body></html>',
].join('');

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
  // surface get a plain 403.
  const ipBlockWriteRule: CfnWebACL.RuleProperty = {
    name: 'IpBlockWrite',
    priority: 20,
    action: { block: {} },
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

  // IP block — read scope: listed IPs (v4 OR v6 read set) on ANY request get a
  // 403 with the banned-region body.
  const ipBlockReadRule: CfnWebACL.RuleProperty = {
    name: 'IpBlockRead',
    priority: 21,
    action: {
      block: {
        customResponse: {
          responseCode: 403,
          customResponseBodyKey: WAF_RESOURCE_NAMES.bannedRegionBodyKey,
        },
      },
    },
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
      [WAF_RESOURCE_NAMES.bannedRegionBodyKey]: {
        contentType: 'TEXT_HTML',
        content: BANNED_REGION_BODY,
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

  return { webAcl, ipSets, logGroup };
}
