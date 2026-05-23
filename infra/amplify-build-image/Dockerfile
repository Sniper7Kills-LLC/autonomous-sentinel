# Custom Amplify Hosting build image for Autonomous Sentinel.
#
# Default Amplify Hosting AL2023 build image does NOT include
# Docker (per AWS docs: only curl/git/openssh/bash/node required).
# Container Lambda functions in the backend (#54 — Whisper
# DockerImageFunction) need `docker build` + `docker push` during
# `ampx pipeline-deploy`. This custom image adds Docker CE on
# top of AL2023 + all Amplify-required tools so the backend
# deploy can run end-to-end.
#
# Built + pushed via this directory's `README.md`:
#   podman build -t public.ecr.aws/<alias>/autonomous-sentinel-build:al2023 .
#   podman push --format docker public.ecr.aws/<alias>/autonomous-sentinel-build:al2023
#
# Wire-up in Amplify Console:
#   Hosting → Build settings → Build image → Custom Build Image
#   → paste full ECR Public URI (alias-prefixed).
#
# Privileged-mode caveat: CodeBuild needs `privilegedMode: true`
# for `dockerd` to start. Amplify Hosting doesn't expose this
# knob via public API. If dockerd refuses to start in the
# Amplify build env, the fallback is rootless buildah or kaniko
# (would require swapping the entrypoint below + symlinking
# `docker` → `buildah` for cdk-assets).

FROM public.ecr.aws/docker/library/amazonlinux:2023

# Amplify required + recommended packages per
# https://docs.aws.amazon.com/amplify/latest/userguide/custom-build-image.html
# AL2023 ships `curl-minimal` (provides /usr/bin/curl) + bash + tar.
# Don't reinstall those — `dnf install curl` conflicts with
# curl-minimal. Only add what's missing.
RUN dnf -y update \
 && dnf -y install \
    git \
    openssh-clients \
    wget \
    gzip \
    sudo \
    shadow-utils \
    procps-ng \
    unzip \
 && dnf clean all

# Node.js 22 + npm (Amplify's strong recommendation — required
# for `ampx pipeline-deploy` to run from the buildspec).
RUN curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - \
 && dnf -y install nodejs \
 && npm install -g npm@latest \
 && dnf clean all

# NVM — Amplify's package-override feature uses NVM to switch
# Node versions at build time.
ENV NVM_DIR=/usr/local/nvm
RUN mkdir -p "$NVM_DIR" \
 && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash \
 && chmod -R a+rx "$NVM_DIR"

# AWS CLI v2 — `ampx pipeline-deploy` uses AWS SDK directly but
# helper scripts / debugging benefit from the CLI being present.
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
 && (cd /tmp && unzip -q awscliv2.zip && ./aws/install) \
 && rm -rf /tmp/awscliv2.zip /tmp/aws

# Docker CE — the load-bearing addition vs the default Amplify
# image. cdk-assets shells out to `docker build` / `docker push`
# for container Lambda image assets.
#
# AL2023's `dnf install docker` ships the moby-engine fork (not
# CE proper) — equivalent for our use case (build + push only).
# AL2023's `docker` package ships the moby-engine fork. No
# `docker-buildx-plugin` in the AL2023 repos — cdk-assets uses
# the legacy `docker build` command (not `docker buildx`) so we
# don't need it.
RUN dnf -y install docker \
 && dnf clean all

# Custom Amplify user matching default AL2023 image conventions
# (per Amplify AL2023 troubleshooting docs). Sudo grants
# escalation when build commands need root (e.g. `dnf install`).
RUN useradd -m -s /bin/bash amplify \
 && echo 'amplify ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/amplify \
 && chmod 0440 /etc/sudoers.d/amplify \
 && usermod -aG docker amplify

# Entrypoint script starts dockerd in the background before
# Amplify's build runner takes over. Pre-flight wait ensures
# `docker info` works by the time the buildspec runs.
COPY dockerd-entrypoint.sh /usr/local/bin/dockerd-entrypoint.sh
RUN chmod +x /usr/local/bin/dockerd-entrypoint.sh

# Amplify build runner is downloaded into the container at
# launch + executed. Our entrypoint backgrounds dockerd then
# exec's into bash so the runner has a working shell.
ENTRYPOINT ["/usr/local/bin/dockerd-entrypoint.sh"]
CMD ["/bin/bash"]
