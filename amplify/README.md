# `@autonomous-sentinel/amplify`

Amplify Gen 2 backend for [Autonomous Sentinel](../README.md).

## Resources

| File                    | Purpose                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `backend.ts`            | `defineBackend()` entry, wires every resource together                     |
| `auth/resource.ts`      | Cognito User Pool + Google federation (Discord OIDC bridge TBD)            |
| `data/resource.ts`      | AppSync GraphQL schema + DynamoDB tables                                   |
| `storage/resource.ts`   | S3 buckets — recordings/originals, recordings/web, pipeline-temp, exports  |
| `functions/preprocess/` | S3-trigger Lambda — silence trim, VAD, transcode to Opus                   |
| `functions/transcribe/` | Pluggable transcription (Whisper / OpenAI / Amazon Transcribe / Bedrock)   |
| `functions/linguistic/` | Hybrid rules + AI fallback parser → structured Message                     |
| `waf.ts`                | AWS WAF Web ACL + four ban IPSets + CloudWatch logging (CLOUDFRONT scope)  |
| `functions/wafSync/`    | Stream-driven reconciler: `BannedCountry`/`BannedIp` rows → live WAF state |

## WAF + country / IP blocking (#198–#202)

`waf.ts` builds a `CLOUDFRONT`-scoped Web ACL (default action **allow** — public
read is free), three AWS managed rule groups, and four IPSets (IPv4/IPv6 ×
write/read). The admin-managed block lists live in the `BannedCountry` and
`BannedIp` Data models; the `wafSync` Lambda — triggered directly by those two
tables' DynamoDB streams — full-reconciles them onto the IPSets (`UpdateIPSet`)
and the runtime-injected geo rules (`UpdateWebACL`).

- **Scope (#201).** Each ban row carries `scope` ∈ {`write`, `read_write`}.
  `write` (default) blocks only the unambiguous write surfaces (`POST/PUT/
DELETE/PATCH` on `/api/*` or `/stripe/*`) so blocked-country visitors keep
  browsing. `read_write` blocks everything and serves the banned-region page.
  GraphQL query-vs-mutation can't be told apart at the edge, so anonymous
  GraphQL mutations are **not** edge-blocked — banned _users_ stay covered by
  the per-user `User.bannedAt` checks. (Follow-up: GraphQL-body inspection.)
- **Cycle-safety.** `wafSync` is `resourceGroupName:'data'`, so it lives in the
  data stack alongside the ban tables — its stream mappings + Scan/stream IAM are
  intra-stack, and it reads via the **raw DynamoDB SDK** (never the Amplify Data
  client, so no `allow.resource` edge). The only cross-stack edge is
  data → `WafStack` (one-directional), so there's no CloudFormation circular
  dependency. (In the shared generic `function` stack it would close a
  `[TranscribeAwsStack, data, function]` cycle — caught at deploy, not synth.)

### Operational step — associate the Web ACL with CloudFront

Amplify Hosting owns its CloudFront distribution, so the backend stack can't
attach the Web ACL itself. After a deploy, associate the exported ARN
(`wafWebAclArn` in `amplify_outputs.json` → `custom`) with the Amplify app's
distribution via the Amplify console **Hosting → Firewall** (or
`aws wafv2 associate-web-acl`). This is the only manual step; everything else
(rules, lists, logging) is code-managed.

### Operational step — associate the geo-rewrite CF function (#679)

The CloudFront **viewer-request** function `eam-blocked-geo-rewrite`
(`waf.ts` → `blockedGeoRewriteFunctionArn` in `amplify_outputs.json` → `custom`;
source in `cloudfront/blocked-geo-rewrite.js`) rewrites a bare `/blocked`
request to `/blocked?country=<CloudFront-Viewer-Country>` so blocked-country
visitors auto-land on their per-country banned-region page (otherwise `/blocked`
shows the generic default). Since Amplify Hosting owns the distribution, attach
it as the **viewer-request** function association on the default cache behavior
(Amplify console or `aws cloudfront`). Ensure the distribution forwards /
populates the `CloudFront-Viewer-Country` header; if it's absent the function
passes through unchanged (generic default page — no breakage).

## Sandbox

```bash
npm run amplify:sandbox       # from monorepo root
```

Generates `amplify_outputs.json` in this directory. Both `web/` and `upload-client/` import that file directly.

## Deploy

CI handles deploy from `main` to the `beta` Amplify Hosting environment until the cutover described in `CLAUDE.md`.
