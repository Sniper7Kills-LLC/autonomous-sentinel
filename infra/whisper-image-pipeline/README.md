# Whisper container image pipeline

Bootstrap script (`bootstrap.sh`) that creates the dedicated CodeBuild project + ECR repo for the Whisper container Lambda. Separates image build from `ampx pipeline-deploy` per AWS Prescriptive Guidance ("Deploy Lambda functions with container images").

## Why a shell script (not CDK)

CDK / CloudFormation `AWS::CodeBuild::Project` resource creation fails with `OAuthProviderException` when the source uses a `CODECONNECTIONS`-backed GitHub connection — even though the same payload created via direct `aws codebuild create-project` CLI succeeds. The CFN-mediated path has an unresolved interaction with CodeConnections that bypasses the connection's principal-resolution. Direct CLI calls work. Shell script is the simplest reliable path; resources are idempotent so re-running is safe.

## What this creates

- **ECR private repo** `autonomous-sentinel/whisper-medium`, lifecycle (keep last 10 images, expire untagged after 14d).
- **IAM role** `autonomous-sentinel-whisper-build-role` with: ECR push + auth, CloudWatch Logs, CodeConnections `GetConnection` / `GetConnectionToken`.
- **CodeBuild project** `autonomous-sentinel-whisper-image`:
  - Source: GitHub via CodeConnection.
  - Image: `aws/codebuild/standard:7.0`, `BUILD_GENERAL1_LARGE`, `privilegedMode: true`.
  - Inline buildspec — builds `amplify/functions/transcribe-whisper/Dockerfile`, tags `:latest` AND `:<git-sha>`, pushes both.
- **Webhook** path-filtered to `^amplify/functions/transcribe-whisper/.*` on `main`.

## Bootstrap

```bash
AWS_PROFILE=eamwatch bash infra/whisper-image-pipeline/bootstrap.sh
```

Re-running is safe — idempotent on every resource.

## First image push (one-time)

The webhook only fires on path-relevant pushes. To populate ECR before the first Amplify Hosting backend deploy, kick off a manual build:

```bash
AWS_PROFILE=eamwatch aws codebuild start-build \
  --project-name autonomous-sentinel-whisper-image \
  --region us-east-1
```

Watch progress:

```bash
AWS_PROFILE=eamwatch aws codebuild list-builds-for-project \
  --project-name autonomous-sentinel-whisper-image \
  --region us-east-1
```

First build ~15-20 min (whisper.cpp compile + medium model download + push). Subsequent builds faster with layer cache.

Once `SUCCEEDED`, ECR has `:latest` + `:<git-sha>` tags. Next `ampx pipeline-deploy` Lambda resolves `fromEcr(repo, { tagOrDigest: 'latest' })`.

## Operate

- **Image updates**: push to `main` touching `amplify/functions/transcribe-whisper/**` → webhook → build.
- **Rollback**: pin `backend.ts` `fromEcr` to a specific `<git-sha>` tag instead of `latest`, redeploy backend.
- **Pipeline updates** (Dockerfile of this script, IAM perms, lifecycle): re-run `bootstrap.sh`.

## Cost

- ECR storage: ~$0.10/GB/month. Whisper image ~1.7 GB → ~$0.17/month per tag, ~$1.70/month for 10-tag rollover.
- CodeBuild BUILD_GENERAL1_LARGE: $0.005/min. ~20-min build = $0.10/build. 1-2 builds/week ≈ $0.40-$0.80/month.

Total < $5/month.

## CDK migration

If a future AWS update fixes the CFN + CodeConnections interaction, replace the shell script with a CDK app. The CDK skeleton previously attempted lives in git history (PR #365 history) for reference.
