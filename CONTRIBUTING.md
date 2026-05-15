# Contributing to Autonomous Sentinel

Thanks for your interest in contributing. Autonomous Sentinel is the v4.0 rewrite of [eam.watch](https://eam.watch) — open source, sponsored and operated by Sniper7Kills LLC.

## Ground rules

- Be respectful. See `CODE_OF_CONDUCT.md`.
- All contributions are licensed under Apache 2.0 (see `LICENSE`). By opening a PR you agree to license your work under the same terms.
- This is an active project with strong opinions on architecture (see `CLAUDE.md`). Read it before opening larger PRs.

## Getting started

### Prerequisites
- Node.js 22 LTS (use `nvm use` — `.nvmrc` pins the version)
- npm 10+ (ships with Node 22)
- AWS account with Amplify Gen 2 access (for backend work)
- An AWS profile configured locally (`aws configure`) named for this project

### Setup
```bash
git clone https://github.com/Sniper7Kills-LLC/autonomous-sentinel.git
cd autonomous-sentinel
nvm use
npm install
```

### Workspace structure
This is an npm-workspaces monorepo with three packages:
- `web/` — Next.js + React PWA
- `amplify/` — Amplify Gen 2 backend
- `upload-client/` — Electron tray app

### Common commands
```bash
npm run lint         # lint all workspaces
npm run typecheck    # typecheck all workspaces
npm run test         # test all workspaces
npm run build        # build all workspaces

npm run amplify:sandbox   # spin up your personal Amplify sandbox
npm run web:dev           # start Next.js dev server
npm run client:dev        # start Electron client in dev mode
```

### Sandbox first
Every backend change must run cleanly in a personal Amplify Gen 2 sandbox before opening a PR. The sandbox creates an isolated stack in your AWS account; tear it down with `npm run amplify:sandbox -- --once` when done.

## Pull requests

- Branch from `main`. Use a descriptive branch name (`feat/...`, `fix/...`, `docs/...`).
- Follow [Conventional Commits](https://www.conventionalcommits.org) for commit messages.
- Keep PRs focused. One concern per PR. Large refactors should be discussed in an issue first.
- All PRs require:
  - Passing `lint`, `typecheck`, and `test` jobs (CI enforces).
  - Updates to `CLAUDE.md` if you change architecture, conventions, or domain semantics.
  - Updates to `README.md` if you change user-visible setup or commands.

## Issues

- Search before opening; we may have a duplicate.
- For bugs, include reproduction steps and environment (OS, Node version, browser if web).
- Feature requests welcome — but Sentinel has explicit scope boundaries (see "Conventions" in `CLAUDE.md`). New manual-entry flows, GDPR plumbing, and Twitter relays are out of scope.

## Reporting security issues

Please do **not** open a public issue for security vulnerabilities. Email security disclosures to the maintainer (see profile).
