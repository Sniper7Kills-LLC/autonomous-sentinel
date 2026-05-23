# Whisper container Lambda image (#53).
#
# Multi-stage build:
#   stage 1 — builds whisper.cpp from a pinned source tarball.
#             Lambda x86_64 CPUs are Skylake-class so AVX + AVX2
#             are both available; we keep them enabled (default).
#   stage 2 — copies the whisper binary + medium English model
#             into the Node 22 Lambda runtime base + drops in
#             the JS handler.
#
# Total image size budget: ~1.7 GB
#   ~1.5 GB ggml-medium.en model
#   ~50  MB whisper binary
#   ~120 MB Node 22 base + handler deps
# Well under Lambda's 10 GB container ceiling.
#
# Build:
#   podman build -t autonomous-sentinel/whisper-medium .
# (or via cdk-assets at deploy time with CDK_DOCKER=podman; see
# `amplify/backend.ts` wiring in #54.)
#
# Local smoke test against the Lambda Runtime Interface Emulator:
#   podman run -p 9000:8080 autonomous-sentinel/whisper-medium
#   curl -X POST 'http://localhost:9000/2015-03-31/functions/function/invocations' \
#     -d '{"Records":[{"body":"..."}]}'

ARG WHISPER_CPP_VERSION=v1.8.4

# ----- stage 1: build whisper.cpp -----------------------------------
FROM public.ecr.aws/lambda/nodejs:22 AS builder
ARG WHISPER_CPP_VERSION

# Build tools.
RUN dnf -y install gcc-c++ make cmake git tar gzip wget && dnf clean all

WORKDIR /build
# Pin to a release tag so the image is reproducible. Bump the
# WHISPER_CPP_VERSION ARG above when updating.
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} \
      https://github.com/ggerganov/whisper.cpp.git . \
 && cmake -B build -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build build --config Release -j

# Download the medium English model. The `download-ggml-model.sh`
# script verifies the SHA-1 checksum that ships with the
# whisper.cpp release, so a model swap or tampered mirror fails
# the build loudly.
RUN bash ./models/download-ggml-model.sh medium.en

# ----- stage 2: runtime ---------------------------------------------
FROM public.ecr.aws/lambda/nodejs:22

# Whisper binary + model in /opt so we don't pollute the Lambda
# task-root. whisper.cpp v1.8.x ships the CLI as `bin/whisper-cli`
# (renamed from `bin/main` in v1.7.x). If bumping
# WHISPER_CPP_VERSION below v1.7.2, update this path to
# `bin/main`.
COPY --from=builder /build/build/bin/whisper-cli /opt/whisper
COPY --from=builder /build/models/ggml-medium.en.bin /opt/models/medium.en.bin
RUN chmod +x /opt/whisper

# Install handler deps (S3 SDK + Amplify Data client lite). Lambda
# task-root is ${LAMBDA_TASK_ROOT} = /var/task.
COPY package.json ${LAMBDA_TASK_ROOT}/
RUN cd ${LAMBDA_TASK_ROOT} && npm install --omit=dev --no-package-lock

COPY handler.mjs ${LAMBDA_TASK_ROOT}/handler.mjs
COPY run-whisper.mjs ${LAMBDA_TASK_ROOT}/run-whisper.mjs

# Lambda runtime entry point. Container Lambdas use CMD as the
# handler identifier (file.export).
CMD [ "handler.handler" ]
