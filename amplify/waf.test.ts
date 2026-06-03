import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { attachWaf, attachAppSyncWaf, WAF_RESOURCE_NAMES } from './waf';

function synth(): { template: Template; webAclArn: string } {
  const app = new App();
  const stack = new Stack(app, 'TestWafStack');
  const { webAcl } = attachWaf(stack);
  return { template: Template.fromStack(stack), webAclArn: webAcl.attrArn };
}

function synthAppSync(): Template {
  const app = new App();
  const stack = new Stack(app, 'TestAppSyncWafStack');
  attachAppSyncWaf(stack);
  return Template.fromStack(stack);
}

describe('attachWaf (#198/#199/#200/#201/#202)', () => {
  it('creates a CLOUDFRONT-scoped Web ACL that defaults to allow', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
    });
  });

  it('attaches the three AWS managed rule groups', () => {
    const { template } = synth();
    for (const name of [
      'AWSManagedRulesCommonRuleSet',
      'AWSManagedRulesKnownBadInputsRuleSet',
      'AWSManagedRulesAmazonIpReputationList',
    ]) {
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: name } },
          }),
        ]),
      });
    }
  });

  it('provisions four IPSets — IPv4/IPv6 × write/read', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::WAFv2::IPSet', 4);
    template.resourcePropertiesCountIs('AWS::WAFv2::IPSet', { IPAddressVersion: 'IPV4' }, 2);
    template.resourcePropertiesCountIs('AWS::WAFv2::IPSet', { IPAddressVersion: 'IPV6' }, 2);
  });

  it('defines the banned page body; read-block 302-redirects, write-block serves it (#689)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      CustomResponseBodies: {
        [WAF_RESOURCE_NAMES.bannedBodyKey]: Match.objectLike({ ContentType: 'TEXT_HTML' }),
      },
      // arrayWith matches in array order: IpBlockWrite (priority 20) precedes
      // IpBlockRead (21).
      Rules: Match.arrayWith([
        // write-block: self-contained banned 403 page
        Match.objectLike({
          Name: 'IpBlockWrite',
          Action: {
            Block: {
              CustomResponse: {
                ResponseCode: 403,
                CustomResponseBodyKey: WAF_RESOURCE_NAMES.bannedBodyKey,
              },
            },
          },
        }),
        // read-block: 302 → /blocked
        Match.objectLike({
          Name: 'IpBlockRead',
          Action: {
            Block: {
              CustomResponse: {
                ResponseCode: 302,
                ResponseHeaders: [
                  { Name: 'Location', Value: WAF_RESOURCE_NAMES.blockedRedirectPath },
                ],
              },
            },
          },
        }),
      ]),
    });
  });

  it('allow-lists /blocked above the (runtime-injected) geo block priority', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AllowBlockedRegionPage',
          Priority: 5,
          Action: { Allow: {} },
        }),
      ]),
    });
    // geo rules are NOT static — wafSync injects them at 10/11
    expect(WAF_RESOURCE_NAMES.geoWritePriority).toBe(10);
    expect(WAF_RESOURCE_NAMES.geoReadPriority).toBe(11);
  });

  it('logs to a 7-day aws-waf-logs-* group', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: 'aws-waf-logs-eam',
      RetentionInDays: 7,
    });
    template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1);
  });

  it('exposes the Web ACL ARN for the CloudFront association step', () => {
    const { webAclArn } = synth();
    expect(webAclArn).toBeTruthy();
  });

  it('provisions the auto-publish viewer-request geo-rewrite CF function (#679)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'eam-blocked-geo-rewrite',
      AutoPublish: true,
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });
  });
});

describe('attachAppSyncWaf (#687)', () => {
  it('creates a REGIONAL Web ACL that defaults to allow', () => {
    const t = synthAppSync();
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
    });
  });

  it('provisions two REGIONAL read IPSets (v4 + v6), no others', () => {
    const t = synthAppSync();
    t.resourceCountIs('AWS::WAFv2::IPSet', 2);
    t.resourcePropertiesCountIs(
      'AWS::WAFv2::IPSet',
      { Scope: 'REGIONAL', IPAddressVersion: 'IPV4' },
      1,
    );
    t.resourcePropertiesCountIs(
      'AWS::WAFv2::IPSet',
      { Scope: 'REGIONAL', IPAddressVersion: 'IPV6' },
      1,
    );
  });

  it('IP rule returns a banned JSON 403 body and has NO managed rule groups (cost)', () => {
    const t = synthAppSync();
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      CustomResponseBodies: {
        banned: Match.objectLike({ ContentType: 'APPLICATION_JSON' }),
      },
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'IpBlockRegionalRead',
          Action: {
            Block: { CustomResponse: { ResponseCode: 403, CustomResponseBodyKey: 'banned' } },
          },
        }),
      ]),
    });
    // no managed rule groups on the AppSync ACL
    const acls = t.findResources('AWS::WAFv2::WebACL');
    const rules = (
      Object.values(acls)[0] as { Properties: { Rules: { Statement?: Record<string, unknown> }[] } }
    ).Properties.Rules;
    expect(rules.some((r) => r.Statement && 'ManagedRuleGroupStatement' in r.Statement)).toBe(
      false,
    );
  });
});
