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

# NOTE — drift check.
# Before touching this image, run:
#   gh api repos/ggml-org/whisper.cpp/releases \
#     | grep -oE '"tag_name":"[^"]*"' | head -5
# Compare against the `ARG WHISPER_CPP_VERSION` below. If the
# pinned tag is more than 2 minor versions behind latest stable,
# propose a bump in the PR description. v1.7.x ships the CLI as
# `bin/main`; v1.8.x+ ships it as `bin/whisper-cli` (the `COPY
# --from=builder` source path below must match the tag).
ARG WHISPER_CPP_VERSION=v1.8.4

# ----- stage 1: build whisper.cpp -----------------------------------
FROM public.ecr.aws/lambda/nodejs:22 AS builder
ARG WHISPER_CPP_VERSION

# Build tools. `xz` is needed to extract the static ffmpeg tarball (#514).
RUN dnf -y install gcc-c++ make cmake git tar gzip wget xz && dnf clean all

# Static ffmpeg for the in-container Opus transcode (#514). Pinned to an
# immutable BtbN FFmpeg-Builds release (ffmpeg 8.1.1, static, LGPL,
# linux64) + SHA-256 verified. The Docker build env is root and has xz,
# so the extraction the Amplify Hosting build couldn't do works here.
# To bump: new autobuild tag + asset + recomputed SHA-256.
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-05-28-14-16/ffmpeg-n8.1.1-9-g58d4114d36-linux64-lgpl-8.1.tar.xz
ARG FFMPEG_SHA256=a54b56aab8f28c3af8c8c49bc18926faed1adfe32c15675171ac7d506ae92c5a
# Extract to a dedicated dir — NOT /build, which the whisper.cpp
# `git clone . ` step below requires to be empty.
RUN mkdir -p /ffmpeg && cd /tmp \
 && wget -q -O ffmpeg.tar.xz "${FFMPEG_URL}" \
 && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
 && tar -xJf ffmpeg.tar.xz --wildcards --strip-components=2 -C /ffmpeg '*/bin/ffmpeg' \
 && rm ffmpeg.tar.xz

WORKDIR /build
# Pin to a release tag so the image is reproducible. Bump the
# WHISPER_CPP_VERSION ARG above when updating.
# cmake flags:
#   `-DBUILD_SHARED_LIBS=OFF` (#446): static-link the CLI so the
#     runtime stage doesn't need `libwhisper.so.1` + `libggml.so.X`.
#   `-DGGML_NATIVE=OFF` (#457): block ggml's default `-march=native`
#     which would bake the BUILDER CPU's instruction set into the
#     binary. CodeBuild standard:7.0 runs on EC2 with AVX-512;
#     Lambda x86_64 only has AVX/AVX2/FMA. Without this flag the
#     binary hits SIGILL right after model load when the first
#     AVX-512 matrix op fires.
#   `-DGGML_AVX512=OFF` (#457): belt-and-braces — even if a future
#     ggml default flips, this explicitly disables the AVX-512
#     codepath. AVX2 + FMA stay on (ggml's defaults), which is the
#     Lambda-supported tier.
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} \
      https://github.com/ggerganov/whisper.cpp.git . \
 && cmake -B build \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF \
      -DGGML_AVX512=OFF \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build build --config Release -j

# Download the medium English model. The `download-ggml-model.sh`
# script verifies the SHA-1 checksum that ships with the
# whisper.cpp release, so a model swap or tampered mirror fails
# the build loudly.
RUN bash ./models/download-ggml-model.sh medium.en

# ----- stage 2: runtime ---------------------------------------------
FROM public.ecr.aws/lambda/nodejs:22

# Runtime dependency: GNU OpenMP shared library (#448). whisper.cpp
# uses OpenMP for parallel matmul/ggml ops; even with
# `-DBUILD_SHARED_LIBS=OFF` (#446) the binary still dynamically
# links `libgomp.so.1` via the `-fopenmp` flag the toolchain
# applies. The Lambda base image doesn't ship it. Disabling
# OpenMP (`-DGGML_OPENMP=OFF`) would avoid the dep but cost
# matmul throughput on the 3008 MB / ~2-vCPU Lambda; keeping
# OpenMP + installing the runtime library is the right trade.
RUN dnf -y install libgomp && dnf clean all

# Whisper binary + model in /opt so we don't pollute the Lambda
# task-root. whisper.cpp v1.8.x ships the CLI as `bin/whisper-cli`
# (renamed from `bin/main` in v1.7.x). If bumping
# WHISPER_CPP_VERSION below v1.7.2, update this path to
# `bin/main`.
COPY --from=builder /build/build/bin/whisper-cli /opt/whisper
COPY --from=builder /build/models/ggml-medium.en.bin /opt/models/medium.en.bin
RUN chmod +x /opt/whisper

# Static ffmpeg for the in-container Opus transcode (#514). The handler
# reads FFMPEG_PATH (default /usr/local/bin/ffmpeg).
COPY --from=builder /ffmpeg/ffmpeg /usr/local/bin/ffmpeg
RUN chmod +x /usr/local/bin/ffmpeg

# Install handler deps (S3 SDK + Amplify Data client lite). Lambda
# task-root is ${LAMBDA_TASK_ROOT} = /var/task.
COPY package.json ${LAMBDA_TASK_ROOT}/
RUN cd ${LAMBDA_TASK_ROOT} && npm install --omit=dev --no-package-lock

COPY handler.mjs ${LAMBDA_TASK_ROOT}/handler.mjs
COPY run-whisper.mjs ${LAMBDA_TASK_ROOT}/run-whisper.mjs
COPY opus-transcode.mjs ${LAMBDA_TASK_ROOT}/opus-transcode.mjs

# Build identity baked into the image so the handler can log which
# build is actually running (#442 follow-up). Defaults survive a
# `podman build .` with no --build-arg flags so local smoke tests
# still work; CodeBuild passes the resolved git SHA + build ID
# from `infra/whisper-image-pipeline/bootstrap.sh`.
ARG GIT_SHA=unknown
ARG BUILD_ID=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_ID=${BUILD_ID}

# Lambda runtime entry point. Container Lambdas use CMD as the
# handler identifier (file.export).
CMD [ "handler.handler" ]
