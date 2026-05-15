# `.claude/` — Project-level Claude Code config

This directory holds project-scoped Claude Code configuration (hooks, permissions, etc.) shared by every contributor who runs Claude Code inside this repo.

## Conventions

- **Do not create git worktrees inside `.claude/`** or any sub-path. Worktrees here confuse Claude Code's project-scoped settings discovery.
- **Do not create git worktrees inside `docs/decisions/`** either — those files are append-only history.
- Hooks added to `settings.json` apply to every developer's Claude Code session in this repo. Discuss in PR before adding intrusive hooks.
- Personal overrides go in `settings.local.json` (git-ignored) — not `settings.json`.
