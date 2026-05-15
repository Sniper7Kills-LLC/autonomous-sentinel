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

### Pre-commit hooks
On `npm install`, husky installs a `pre-commit` hook that runs `lint-staged`:
- `*.{ts,tsx,js,jsx,mjs,cjs}` → `eslint --fix` + `prettier --write`
- `*.{json,md,yml,yaml,css}` → `prettier --write`

If you need to bypass for a quick fix, `git commit --no-verify` skips the hook. Don't make a habit of it — CI will catch what the hook would have.

### Sandbox first
Every backend change must run cleanly in a personal Amplify Gen 2 sandbox before opening a PR. The sandbox creates an isolated stack in your AWS account; tear it down with `npx ampx sandbox delete` from inside `amplify/` when done.
<<<<<<< HEAD

## AWS developer setup

The Amplify backend (`amplify/` workspace) deploys to a personal AWS sandbox per developer. Set this up once.

### 1. Install AWS CLI v2

| OS | Command |
|---|---|
| Linux | `curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip && unzip awscliv2.zip && sudo ./aws/install` |
| macOS | `brew install awscli` |
| Windows | `winget install Amazon.AWSCLI` |

Verify: `aws --version` should report ≥ 2.x.

### 2. Configure a named profile

```bash
aws configure --profile autonomous-sentinel-dev
# AWS Access Key ID:        <your dev IAM user access key>
# AWS Secret Access Key:    <secret>
# Default region name:      us-east-1
# Default output format:    json
```

Then in your shell rc (`~/.bashrc`, `~/.zshrc`, or PowerShell `$PROFILE`):

```bash
export AWS_PROFILE=autonomous-sentinel-dev
export AWS_REGION=us-east-1
```

### 3. IAM permissions

For your personal sandbox, the simplest path is an IAM user with `AdministratorAccess` (it's *your* sandbox in *your* account). Production deploys use scoped least-privilege roles — out of scope for sandbox work.

If you need to scope down: Amplify Gen 2 needs CloudFormation full access plus permissions on the resources you `define*()` (Cognito, AppSync, DynamoDB, S3, Lambda, SES if used, etc.). The Amplify docs have a starter policy.

### 4. Spin up the sandbox

```bash
npm run amplify:sandbox
# Equivalent: cd amplify && npx ampx sandbox
```

This deploys an isolated stack named after your machine + Amplify identity (e.g. `amplify-autonomoussentinel-yourname-sandbox-xxxx`) and writes `amplify_outputs.json` to `amplify/`. Both `web/` and `upload-client/` import that file at runtime.

The first sandbox spin-up takes 5-10 minutes (CloudFormation provisioning everything). Subsequent updates are typically under a minute.

### 5. Set Amplify secrets

Some resources (Google OAuth client secret, Stripe keys, etc.) are referenced as `secret('NAME')` in the backend code. They live in AWS Systems Manager Parameter Store and must be set per sandbox before `defineAuth` / `defineFunction` can deploy them:

```bash
cd amplify
npx ampx sandbox secret set GOOGLE_CLIENT_ID
npx ampx sandbox secret set GOOGLE_CLIENT_SECRET
# etc. — see amplify/auth/resource.ts and amplify/functions/*/resource.ts for the full list
```

### 6. Tear down

When you're done for the day:

```bash
cd amplify
npx ampx sandbox delete
```

An idle Amplify Gen 2 sandbox for this stack costs ~$0/mo at the dev tier (DynamoDB on-demand + S3 Standard with no traffic), but tearing down is hygienic and prevents accidental drift.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Could not load default credentials` | `AWS_PROFILE` not exported, or profile name typo |
| Sandbox deploys to wrong region | `AWS_REGION` not set or shell rc not sourced |
| `Token has expired` | Refresh credentials (`aws sso login` if using SSO, or rotate access keys) |
| Sandbox lockfile errors | Another `ampx sandbox` is already running for this directory; check for stale processes |
| `secret 'X' not found` | Run `npx ampx sandbox secret set X` first |
=======
>>>>>>> a7aa758 (chore(hooks): wire husky + lint-staged pre-commit (#10))

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
