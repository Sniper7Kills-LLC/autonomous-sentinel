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
  browsing. `read_write` blocks everything. GraphQL query-vs-mutation can't be
  told apart at the edge, so anonymous GraphQL mutations are **not** edge-blocked
  — banned _users_ stay covered by the per-user `User.bannedAt` checks.
- **Banned page on every ban-hit (#689).** Block actions display a ban page, not
  a bare 403, via the native WAF mechanisms: website **read**-blocks **302-redirect
  to `/blocked`** (the rich per-country page #202/#113); website **write**-blocks
  return a self-contained `banned` 403 HTML body; the **AppSync** (API) ACL returns
  a `banned` 403 **JSON** body (a 302 would break GraphQL clients). The
  `AllowBlockedRegionPage` rule (priority 5, above the block rules) keeps `/blocked`
  reachable so the redirect can't loop. AWS-managed rule-group (attack) blocks keep
  the default 403 — different semantics, and per-rule custom responses across a
  managed group are impractical.
- **Cycle-safety.** `wafSync` is `resourceGroupName:'data'`, so it lives in the
  data stack alongside the ban tables — its stream mappings + Scan/stream IAM are
  intra-stack, and it reads via the **raw DynamoDB SDK** (never the Amplify Data
  client, so no `allow.resource` edge). The only cross-stack edge is
  data → `WafStack` (one-directional), so there's no CloudFormation circular
  dependency. (In the shared generic `function` stack it would close a
  `[TranscribeAwsStack, data, function]` cycle — caught at deploy, not synth.)

### Web ACL association — code-managed (#681)

The Web ACL is attached to the Amplify Hosting app **in code**: `backend.ts`
creates a `wafv2.CfnWebACLAssociation` keyed on the Amplify app ARN (Amplify's
native WAF integration — a CLOUDFRONT-scope Web ACL, same account, us-east-1).
`ampx pipeline-deploy` applies it on every build, so there is **no manual
console step**. The association is guarded on `AWS_APP_ID` so it is created only
in a real Amplify pipeline build, never in `ampx sandbox`. Verify after deploy
with `aws amplify get-app --app-id <id> --query app.wafConfiguration` (non-null
once associated). Rules, lists, and logging are likewise code-managed.

### Geo-rewrite CF function (#679) — dormant

The `/blocked` auto-country-routing CloudFront function
(`cloudfront/blocked-geo-rewrite.js`) **cannot be attached to the Amplify-managed
distribution** — Amplify's native integration covers WAF only, not custom
CloudFront Functions. The function ships built + tested but **dormant**; it would
activate only under a self-managed CloudFront (a future option, e.g. at the
SSR/hosting migration #330). Until then `/blocked` shows the generic default
page, with per-country pages reachable via `?country=<ISO2>`.

## Sandbox

```bash
npm run amplify:sandbox       # from monorepo root
```

Generates `amplify_outputs.json` in this directory. Both `web/` and `upload-client/` import that file directly.

## Deploy

CI handles deploy from `main` to the `beta` Amplify Hosting environment until the cutover described in `CLAUDE.md`.
