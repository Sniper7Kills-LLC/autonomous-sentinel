# Custom Amplify Hosting build image

Adds Docker CE on top of Amazon Linux 2023 + Amplify's required
build tools so `ampx pipeline-deploy` can build + push the
Whisper container Lambda image during a backend deploy.

## Why

The default Amplify Hosting AL2023 build image does **not** include
Docker. cdk-assets needs `docker build` / `docker push` to publish
container-image assets declared via `DockerImageFunction`. Without
Docker available in the build env, backend deploys fail at the
"Building and publishing assets" stage.

## ECR Public

Owner-namespaced repo:

- Registry alias (auto-assigned): `l2g3y7y8`
  _(custom alias `eamwatch` requested via AWS Support — swap the
  URL below when granted.)_
- Repo URI: `public.ecr.aws/l2g3y7y8/autonomous-sentinel-build`

## Build + push

Local:

```bash
cd infra/amplify-build-image
podman build --format docker -t public.ecr.aws/l2g3y7y8/autonomous-sentinel-build:al2023 .
aws ecr-public get-login-password --region us-east-1 --profile eamwatch \
  | podman login --username AWS --password-stdin public.ecr.aws
podman push --format docker public.ecr.aws/l2g3y7y8/autonomous-sentinel-build:al2023
```

`--format docker` forces the legacy Docker v2 schema 2 manifest
ECR Public expects (podman defaults to OCI).

## Wire to Amplify Hosting

Console-only setting (no public API):

1. Open the Amplify Console for the app.
2. Hosting → Build settings → Build image settings → Edit.
3. Build image → **Custom Build Image**.
4. Paste the full ECR Public URI:
   `public.ecr.aws/l2g3y7y8/autonomous-sentinel-build:al2023`
5. Save.
6. Trigger a new deploy on `main` (push a commit or re-run job).

## Privileged-mode caveat

CodeBuild needs `privilegedMode: true` for `dockerd` to start.
Amplify Hosting does not expose this knob through its public API;
the underlying CodeBuild project's `privilegedMode` may default
to `false`. If `dockerd` cannot bind to `/var/run/docker.sock`,
the entrypoint script (`dockerd-entrypoint.sh`) logs a WARNING +
continues — non-container build steps still run.

If the first deploy with this image fails with `dockerd: error
starting daemon`, the fallback is to swap Docker CE for rootless
**buildah** or **kaniko** in this Dockerfile + symlink `docker`
→ wrapper script so cdk-assets continues to work.

## Update cadence

Bump base image + Node version when:

- AL2023 patch security update lands (`dnf -y update` rebuilds).
- Node 22 LTS minor releases (matches the project's `.nvmrc`).
- Docker / docker-buildx-plugin major release.

Rebuild + push with a new tag (`:al2023-YYYYMMDD`) for
auditability; keep `:al2023` floating to the latest stable.
