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
