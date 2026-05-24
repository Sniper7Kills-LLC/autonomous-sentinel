#!/usr/bin/env bash
# Applies the branch-protection rules in .github/branch-protection.json
# to the `main` branch of this repo (#371).
#
# Idempotent — re-running just overwrites the rule with the same payload.
# Requires `gh` authenticated as a repo admin (the `gh api PUT
# /repos/.../branches/.../protection` endpoint is admin-only).
#
# Usage:
#   .github/scripts/apply-branch-protection.sh                 # uses current repo
#   .github/scripts/apply-branch-protection.sh OWNER/REPO      # override
#
# The `_comment` field in branch-protection.json is stripped before send
# because the GitHub API rejects unknown keys.
set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$SCRIPT_DIR/../branch-protection.json"

if [[ ! -f "$PAYLOAD" ]]; then
  echo "error: $PAYLOAD not found" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to strip the documentation comment from the payload" >&2
  exit 1
fi

echo "Applying branch protection to $REPO:main from $PAYLOAD"

jq 'del(._comment)' "$PAYLOAD" \
  | gh api \
      --method PUT \
      -H "Accept: application/vnd.github+json" \
      "repos/$REPO/branches/main/protection" \
      --input -

echo "Done. Current protection summary:"
gh api "repos/$REPO/branches/main/protection" --jq '{
  required_status_checks: .required_status_checks.contexts,
  strict: .required_status_checks.strict,
  approving_reviews: .required_pull_request_reviews.required_approving_review_count,
  dismiss_stale: .required_pull_request_reviews.dismiss_stale_reviews,
  enforce_admins: .enforce_admins.enabled,
  allow_force_pushes: .allow_force_pushes.enabled,
  allow_deletions: .allow_deletions.enabled,
  required_conversation_resolution: .required_conversation_resolution.enabled
}'
