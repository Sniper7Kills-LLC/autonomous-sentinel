import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * CodeQL workflow contract (#370).
 *
 * GitHub-hosted CodeQL is free for public repos. We use the advanced
 * (workflow-file) setup rather than the default (Settings UI) setup so
 * the configuration is reviewable in PRs and reproducible across forks.
 *
 * The four invariants below are what the workflow must hold:
 *   - scans on push to `main`, on PR against `main`, AND on a recurring
 *     schedule (default-setup parity — catches CVEs disclosed against
 *     dependencies after merge),
 *   - language is `javascript-typescript` (covers all three workspaces),
 *   - uses the official `github/codeql-action/{init,analyze}@v4` actions,
 *   - declares the security-events write permission required for
 *     uploading findings to the Security tab.
 */

interface CodeqlWorkflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, CodeqlJob>;
}

interface CodeqlJob {
  strategy?: { matrix?: { language?: readonly string[] } };
  permissions?: Record<string, string>;
  steps?: readonly { uses?: string; with?: Record<string, string> }[];
}

const workflowPath = resolve(__dirname, '..', '.github', 'workflows', 'codeql.yml');
const workflow = parse(readFileSync(workflowPath, 'utf8')) as CodeqlWorkflow;
const analyzeJob = Object.values(workflow.jobs ?? {})[0];
const steps = analyzeJob?.steps ?? [];

describe('codeql.yml — triggers', () => {
  it('runs on push to main', () => {
    const push = workflow.on?.push as { branches?: readonly string[] } | undefined;
    expect(push?.branches).toContain('main');
  });

  it('runs on pull_request against main', () => {
    const pr = workflow.on?.pull_request as { branches?: readonly string[] } | undefined;
    expect(pr?.branches).toContain('main');
  });

  it('runs on a schedule (weekly cron) so disclosed CVEs surface against the latest main', () => {
    // Catches dependency CVEs disclosed after the most recent PR closed.
    // Without this, a quiet repo can drift months past a known bad rev.
    const schedule = workflow.on?.schedule as readonly { cron?: string }[] | undefined;
    expect(schedule).toBeDefined();
    expect(schedule?.length ?? 0).toBeGreaterThan(0);
    expect(schedule?.[0]?.cron, 'cron expression missing').toBeTruthy();
  });
});

describe('codeql.yml — analysis configuration', () => {
  it('targets the javascript-typescript language pack', () => {
    // The repo is TypeScript across all three workspaces. CodeQL split
    // the JS and TS packs in 2024 — `javascript-typescript` is the
    // single combined pack covering both.
    const langs = analyzeJob?.strategy?.matrix?.language ?? [];
    expect(langs).toContain('javascript-typescript');
  });

  it('uses the official github/codeql-action/init@v4 step', () => {
    const init = steps.find((s) => s.uses?.startsWith('github/codeql-action/init'));
    expect(init?.uses).toMatch(/^github\/codeql-action\/init@v4/);
    expect(init?.with?.languages).toBeTruthy();
  });

  it('uses the official github/codeql-action/analyze@v4 step', () => {
    const analyze = steps.find((s) => s.uses?.startsWith('github/codeql-action/analyze'));
    expect(analyze?.uses).toMatch(/^github\/codeql-action\/analyze@v4/);
  });
});

describe('codeql.yml — permissions', () => {
  it('grants security-events: write so findings reach the Security tab', () => {
    // Without `security-events: write` on the job (or top-level), the
    // analyze step succeeds but the SARIF upload fails silently and
    // nothing shows up under repo Security.
    const jobPerms = analyzeJob?.permissions?.['security-events'];
    const topPerms = workflow.permissions?.['security-events'];
    expect(jobPerms ?? topPerms).toBe('write');
  });
});
