#!/bin/bash
# Custom Amplify Hosting build image entrypoint.
#
# Starts dockerd in the background, waits for the socket to be
# ready, then exec's into the command Amplify's build runner
# expects (typically `/bin/bash`).
#
# Requires the container to be launched with `privileged: true`
# (CodeBuild privilegedMode flag). Amplify Hosting does not
# expose this knob in its public API; if dockerd can't bind to
# /var/run/docker.sock the buildspec gracefully degrades + the
# build runner still runs (Amplify-only steps work, only the
# `ampx pipeline-deploy` container-asset publish step fails).

set -euo pipefail

# Ensure /var/run exists + is writable.
mkdir -p /var/run

# Start dockerd in the background. Output to a known location
# so failures are diagnosable from the Amplify build log.
if command -v dockerd >/dev/null 2>&1; then
  dockerd \
    --host=unix:///var/run/docker.sock \
    --storage-driver=vfs \
    > /var/log/dockerd.log 2>&1 &

  # Wait up to 30s for dockerd to be ready before continuing.
  # If it never comes up, log the dockerd output + continue so
  # the build runner can at least surface a useful error.
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      echo "[dockerd-entrypoint] docker daemon ready"
      break
    fi
    sleep 1
  done

  if ! docker info >/dev/null 2>&1; then
    echo "[dockerd-entrypoint] WARNING: docker daemon failed to start" >&2
    echo "[dockerd-entrypoint] dockerd log tail:" >&2
    tail -50 /var/log/dockerd.log >&2 || true
    echo "[dockerd-entrypoint] continuing — non-container builds will still work" >&2
  fi
fi

# Hand control to whatever Amplify's build runner exec's into
# the container (typically /bin/bash).
exec "$@"
