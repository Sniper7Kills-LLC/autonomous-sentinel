# `@autonomous-sentinel/amplify`

Amplify Gen 2 backend for [Autonomous Sentinel](../README.md).

## Resources

| File | Purpose |
|---|---|
| `backend.ts` | `defineBackend()` entry, wires every resource together |
| `auth/resource.ts` | Cognito User Pool + Google federation (Discord OIDC bridge TBD) |
| `data/resource.ts` | AppSync GraphQL schema + DynamoDB tables |
| `storage/resource.ts` | S3 buckets — recordings/originals, recordings/web, pipeline-temp, exports |
| `functions/preprocess/` | S3-trigger Lambda — silence trim, VAD, transcode to Opus |
| `functions/transcribe/` | Pluggable transcription (Whisper / OpenAI / Amazon Transcribe / Bedrock) |
| `functions/linguistic/` | Hybrid rules + AI fallback parser → structured Message |

## Sandbox

```bash
npm run amplify:sandbox       # from monorepo root
```

Generates `amplify_outputs.json` in this directory. Both `web/` and `upload-client/` import that file directly.

## Deploy

CI handles deploy from `main` to the `beta` Amplify Hosting environment until the cutover described in `CLAUDE.md`.
