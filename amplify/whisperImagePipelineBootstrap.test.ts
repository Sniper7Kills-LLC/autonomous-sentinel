import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Whisper image pipeline bootstrap contract (#401).
 *
 * `infra/whisper-image-pipeline/bootstrap.sh` provisions the CodeBuild
 * project + GitHub webhook that builds the Whisper container image on
 * push to `main`. Two invariants matter for status-check noise on
 * unrelated PRs:
 *
 *   1. The webhook's `filterGroups` must be PUSH-only, branch-gated to
 *      `main`, file-path-gated to the transcribe-whisper Lambda dir.
 *      Otherwise PRs trigger spurious builds.
 *
 *   2. The webhook's `pullRequestBuildPolicy` must be set to
 *      `FORK_PULL_REQUESTS`. CodeBuild's API default is
 *      `ALL_PULL_REQUESTS`, which posts a "approval required" status
 *      check on every PR commit — confusing + scary, especially on
 *      Dependabot PRs.
 *
 * Drift in either is a CI-visible diff so a future bootstrap edit
 * cannot silently re-introduce the noise.
 */

const bootstrapPath = resolve(__dirname, '..', 'infra', 'whisper-image-pipeline', 'bootstrap.sh');
const bootstrap = readFileSync(bootstrapPath, 'utf8');

describe('whisper-image-pipeline bootstrap.sh — webhook filterGroups', () => {
  it('keeps EVENT pattern PUSH-only (no PULL_REQUEST events)', () => {
    expect(bootstrap).toMatch(/"type":"EVENT","pattern":"PUSH"/);
    expect(bootstrap).not.toMatch(/"type":"EVENT","pattern":"PULL_REQUEST/);
  });

  it('gates HEAD_REF to the configured trigger branch', () => {
    expect(bootstrap).toMatch(/"type":"HEAD_REF","pattern":"refs\/heads\/'"\$\{TRIGGER_BRANCH\}/);
  });

  it('gates FILE_PATH to the transcribe-whisper Lambda directory', () => {
    expect(bootstrap).toMatch(
      /"type":"FILE_PATH","pattern":"\^amplify\/functions\/transcribe-whisper\/\.\*"/,
    );
  });
});

describe('whisper-image-pipeline bootstrap.sh — pullRequestBuildPolicy', () => {
  it('sets requiresCommentApproval to FORK_PULL_REQUESTS so internal PRs skip the spurious status check', () => {
    expect(bootstrap).toMatch(/"requiresCommentApproval":"FORK_PULL_REQUESTS"/);
    // Defense in depth: catch a future edit that re-introduces the
    // CodeBuild API default of ALL_PULL_REQUESTS.
    expect(bootstrap).not.toMatch(/"requiresCommentApproval":"ALL_PULL_REQUESTS"/);
  });

  it('approverRoles keeps the GitHub write/maintain/admin set so fork PRs are still gated', () => {
    expect(bootstrap).toMatch(
      /"approverRoles":\["GITHUB_WRITE","GITHUB_MAINTAIN","GITHUB_ADMIN"\]/,
    );
  });

  it('passes --pull-request-build-policy to aws codebuild create-webhook', () => {
    // The flag must reach the CLI invocation, not just live in a
    // variable that never gets referenced. The test pins the wiring.
    expect(bootstrap).toMatch(
      /aws codebuild create-webhook[\s\S]+--pull-request-build-policy "\$\{PR_BUILD_POLICY\}"/,
    );
  });
});
