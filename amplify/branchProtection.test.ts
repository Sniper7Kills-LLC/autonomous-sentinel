import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Branch-protection payload contract (#371).
 *
 * `.github/branch-protection.json` is the declarative source of truth
 * for the protection rules on `main`. `.github/scripts/apply-branch-protection.sh`
 * PUTs it to the GitHub API. The invariants below describe the
 * minimum gates the project commits to:
 *
 *   - CI must pass before merge (the `all-checks` aggregate + the
 *     CodeQL analyze run).
 *   - Branch must be up to date with main before merge so CI on stale
 *     refs can't be a green-on-stale-tree false negative.
 *   - PRs are required, but reviews are not (single-maintainer repo —
 *     bumping to 1 would lock the owner out of merging their own PR).
 *   - Force-pushes, deletions, and unresolved conversations are
 *     blocked.
 *
 * Drift in any of these silently weakens the merge gate.
 */

interface BranchProtectionPayload {
  required_status_checks?: {
    strict?: boolean;
    contexts?: readonly string[];
  };
  enforce_admins?: boolean;
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    required_approving_review_count?: number;
  };
  required_conversation_resolution?: boolean;
  allow_force_pushes?: boolean;
  allow_deletions?: boolean;
}

const payloadPath = resolve(__dirname, '..', '.github', 'branch-protection.json');
const payload = JSON.parse(readFileSync(payloadPath, 'utf8')) as BranchProtectionPayload;

describe('branch-protection.json — required status checks', () => {
  it('requires the all-checks aggregate from the CI workflow', () => {
    expect(payload.required_status_checks?.contexts).toContain('all-checks');
  });

  it('requires the CodeQL javascript-typescript analyze run', () => {
    // Check name matches the matrix entry in .github/workflows/codeql.yml.
    expect(payload.required_status_checks?.contexts).toContain('Analyze (javascript-typescript)');
  });

  it('requires the PR branch to be up to date with main (strict)', () => {
    // Without `strict`, CI could go green on a stale tree that breaks
    // post-merge. `strict: true` forces a rebase/merge before merge.
    expect(payload.required_status_checks?.strict).toBe(true);
  });
});

describe('branch-protection.json — PR requirement', () => {
  it('requires a pull request before merging (block defined)', () => {
    expect(payload.required_pull_request_reviews).toBeDefined();
  });

  it('sets required_approving_review_count to 0 — single-maintainer repo', () => {
    // Setting to 1 would lock the owner out of merging their own PR
    // (PR author cannot approve own PR). Raise once a second
    // maintainer joins.
    expect(payload.required_pull_request_reviews?.required_approving_review_count).toBe(0);
  });

  it('dismisses stale reviews on new commits', () => {
    expect(payload.required_pull_request_reviews?.dismiss_stale_reviews).toBe(true);
  });
});

describe('branch-protection.json — lockdown', () => {
  it('blocks force-pushes to main', () => {
    expect(payload.allow_force_pushes).toBe(false);
  });

  it('blocks branch deletion', () => {
    expect(payload.allow_deletions).toBe(false);
  });

  it('requires conversation resolution before merge', () => {
    expect(payload.required_conversation_resolution).toBe(true);
  });

  it('does NOT enforce protection against administrators (break-glass escape hatch)', () => {
    // Owner retains the ability to override in an emergency. Issue
    // body explicitly called this out; revisit if abused.
    expect(payload.enforce_admins).toBe(false);
  });
});
