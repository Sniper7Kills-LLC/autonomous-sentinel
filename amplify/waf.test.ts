import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { attachWaf, WAF_RESOURCE_NAMES } from './waf';

function synth(): { template: Template; webAclArn: string } {
  const app = new App();
  const stack = new Stack(app, 'TestWafStack');
  const { webAcl } = attachWaf(stack);
  return { template: Template.fromStack(stack), webAclArn: webAcl.attrArn };
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

  it('serves the banned-region custom response body on read blocks', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      CustomResponseBodies: {
        [WAF_RESOURCE_NAMES.bannedRegionBodyKey]: Match.objectLike({ ContentType: 'TEXT_HTML' }),
      },
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'IpBlockRead',
          Action: {
            Block: {
              CustomResponse: {
                ResponseCode: 403,
                CustomResponseBodyKey: WAF_RESOURCE_NAMES.bannedRegionBodyKey,
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
});
