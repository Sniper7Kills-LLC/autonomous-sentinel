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
- **Cycle-safety.** `wafSync` reads the tables via the **raw DynamoDB SDK**
  (never the Amplify Data client) and its stream mappings/IAM live in the
  function stack, so every cross-stack edge points _out_ of the function — no
  CloudFormation circular dependency.

### Operational step — associate the Web ACL with CloudFront

Amplify Hosting owns its CloudFront distribution, so the backend stack can't
attach the Web ACL itself. After a deploy, associate the exported ARN
(`wafWebAclArn` in `amplify_outputs.json` → `custom`) with the Amplify app's
distribution via the Amplify console **Hosting → Firewall** (or
`aws wafv2 associate-web-acl`). This is the only manual step; everything else
(rules, lists, logging) is code-managed.

## Sandbox

```bash
npm run amplify:sandbox       # from monorepo root
```

Generates `amplify_outputs.json` in this directory. Both `web/` and `upload-client/` import that file directly.

## Deploy

CI handles deploy from `main` to the `beta` Amplify Hosting environment until the cutover described in `CLAUDE.md`.
