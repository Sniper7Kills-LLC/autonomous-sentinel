import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Build-identity wiring (#442 follow-up).
 *
 * The Whisper container bakes the git SHA + CodeBuild ID into the
 * image at `docker build` time so the running Lambda can log which
 * exact build it's serving. Three files have to stay in sync for
 * that to work:
 *
 *   1. Dockerfile — ARG + ENV for GIT_SHA and BUILD_ID.
 *   2. handler.mjs — reads the env vars + logs on cold start.
 *   3. bootstrap.sh buildspec — passes the build args.
 *
 * Drift between them silently re-disables the cold-start identity
 * log, which is exactly the signal we added it to provide. These
 * tests pin the wiring file-by-file.
 */

const HERE = __dirname;
const REPO_ROOT = join(HERE, '..', '..', '..');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Whisper image build-identity wiring', () => {
  it('Dockerfile declares GIT_SHA + BUILD_ID build args with safe defaults', () => {
    const dockerfile = read(join(HERE, 'Dockerfile'));
    expect(dockerfile).toMatch(/ARG\s+GIT_SHA=unknown/);
    expect(dockerfile).toMatch(/ARG\s+BUILD_ID=unknown/);
    expect(dockerfile).toMatch(/ENV\s+GIT_SHA=\$\{GIT_SHA\}/);
    expect(dockerfile).toMatch(/ENV\s+BUILD_ID=\$\{BUILD_ID\}/);
  });

  it('Dockerfile builds whisper.cpp statically so the CLI does not depend on libwhisper.so at runtime (#446)', () => {
    const dockerfile = read(join(HERE, 'Dockerfile'));
    // Without -DBUILD_SHARED_LIBS=OFF the v1.8.x default produces a
    // dynamic binary; the runtime stage doesn't carry the .so files
    // and every invocation fails with `cannot open shared object
    // file: libwhisper.so.1` (observed on commit 9cc4c32).
    expect(dockerfile).toContain('-DBUILD_SHARED_LIBS=OFF');
  });

  it('Dockerfile disables ggml native CPU detection + AVX-512 so the binary runs on Lambda CPUs (#457)', () => {
    const dockerfile = read(join(HERE, 'Dockerfile'));
    // CodeBuild standard:7.0 runs on EC2 instances with AVX-512;
    // ggml defaults `GGML_NATIVE=ON` adds `-march=native` which
    // bakes those instructions into the binary. Lambda x86_64 only
    // has AVX/AVX2/FMA → SIGILL right after model load.
    expect(dockerfile).toContain('-DGGML_NATIVE=OFF');
    expect(dockerfile).toContain('-DGGML_AVX512=OFF');
  });

  it('Dockerfile installs libgomp in the runtime stage so OpenMP-linked whisper binary loads (#448)', () => {
    const dockerfile = read(join(HERE, 'Dockerfile'));
    // Even after -DBUILD_SHARED_LIBS=OFF the binary dynamically
    // links libgomp.so.1 (GNU OpenMP runtime) because whisper.cpp
    // builds with -fopenmp. The Lambda nodejs:22 base doesn't ship
    // libgomp; without this install the CLI fails at exec with
    // `cannot open shared object file: libgomp.so.1`
    // (observed on Recording fc63246f at 2026-05-25 00:04 UTC).
    expect(dockerfile).toMatch(/dnf\s+-y\s+install[^\n]*\blibgomp\b/);
  });

  it('handler.mjs reads GIT_SHA + BUILD_ID from process.env on init', () => {
    const handler = read(join(HERE, 'handler.mjs'));
    expect(handler).toContain('process.env.GIT_SHA');
    expect(handler).toContain('process.env.BUILD_ID');
  });

  it('handler.mjs logs build identity at module load (cold-start visibility)', () => {
    const handler = read(join(HERE, 'handler.mjs'));
    // The console.info must fire at module scope, not nested inside
    // the request handler — otherwise it only emits when an SQS
    // event arrives, hiding the identity on idle invocations.
    //
    // Regex requires the log to carry an object-literal payload
    // (`,` + `{`) so a refactor that drops `{ gitSha, buildId }`
    // can't slip past without also breaking this assertion.
    expect(handler).toMatch(/console\.info\(\s*['"]whisper-handler: image identity['"]\s*,\s*\{/);
  });

  it('handler.mjs annotates the per-invoke PARSING log with gitSha + buildId', () => {
    const handler = read(join(HERE, 'handler.mjs'));
    // Without these fields on the per-invoke log the operator has
    // to correlate the cold-start line with each invocation by
    // request ID — easy to lose.
    expect(handler).toMatch(/gitSha:\s*IMAGE_GIT_SHA/);
    expect(handler).toMatch(/buildId:\s*IMAGE_BUILD_ID/);
  });

  it('CodeBuild bootstrap passes --build-arg GIT_SHA + BUILD_ID into docker build', () => {
    const bootstrap = read(join(REPO_ROOT, 'infra', 'whisper-image-pipeline', 'bootstrap.sh'));
    expect(bootstrap).toContain('--build-arg GIT_SHA=$CODEBUILD_RESOLVED_SOURCE_VERSION');
    expect(bootstrap).toContain('--build-arg BUILD_ID=$CODEBUILD_BUILD_ID');
  });
});
