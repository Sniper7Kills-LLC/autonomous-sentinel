import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Amplify Hosting build-spec contract (#6).
 *
 * The monorepo deploys via Amplify Gen 2 fullstack from the repo root.
 * Amplify Hosting reads `amplify.yml` to learn:
 *   - which workspace to detect as the Next.js app (drives SSR
 *     framework auto-detect — required for the `web/` package),
 *   - how to install hoisted npm-workspace dependencies,
 *   - how to run `ampx pipeline-deploy` against the correct branch +
 *     Amplify App ID,
 *   - where the Next.js build output lands.
 *
 * The four pieces below are the failure surface — if any drifts, the
 * Amplify deploy either picks the wrong framework, fails to install
 * deps, deploys the wrong backend, or serves a 404. Pin them.
 */

interface BuildSpec {
  version?: number;
  applications?: ApplicationSpec[];
}

interface ApplicationSpec {
  appRoot?: string;
  backend?: PhaseGroup;
  frontend?: FrontendPhaseGroup;
}

interface PhaseGroup {
  phases?: Record<string, PhaseSpec | undefined>;
}

interface FrontendPhaseGroup extends PhaseGroup {
  artifacts?: { baseDirectory?: string; files?: readonly string[] };
  cache?: { paths?: readonly string[] };
}

interface PhaseSpec {
  commands?: readonly string[];
}

const buildSpecPath = resolve(__dirname, '..', 'amplify.yml');
const buildSpec = parse(readFileSync(buildSpecPath, 'utf8')) as BuildSpec;
const app = buildSpec.applications?.[0];

describe('amplify.yml — top level', () => {
  it('declares schema version 1', () => {
    expect(buildSpec.version).toBe(1);
  });

  it('declares exactly one application — the `web/` workspace', () => {
    expect(buildSpec.applications).toHaveLength(1);
    expect(app?.appRoot).toBe('web');
  });
});

describe('amplify.yml — backend phase (Amplify Gen 2 deploy)', () => {
  const commands = app?.backend?.phases?.build?.commands ?? [];

  it('runs `ampx pipeline-deploy` against the deploy-time branch + app id', () => {
    // Branch + app id are injected by Amplify Hosting at deploy time;
    // hard-coding either would break preview environments and the
    // production cutover (#230). Token references only.
    const hasDeploy = commands.some(
      (c) =>
        c.includes('ampx pipeline-deploy') &&
        c.includes('$AWS_BRANCH') &&
        c.includes('$AWS_APP_ID'),
    );
    expect(hasDeploy).toBe(true);
  });

  it('installs workspace deps from the monorepo root before deploy', () => {
    // The `amplify/` workspace lives one level above `appRoot: web`, so
    // a bare `npm ci` inside `web/` would not install its deps.
    // Either `--prefix ../` or `cd ..` must appear in the install step,
    // AND that install step must run before the deploy — otherwise
    // `ampx pipeline-deploy` runs without the `amplify/` workspace
    // installed and the deploy fails partway. Pin both the presence
    // and the ordering so an accidental reorder is a CI-visible diff.
    const installIdx = commands.findIndex(
      (c) => c.includes('npm ci') && (c.includes('--prefix ../') || c.includes('cd ..')),
    );
    const deployIdx = commands.findIndex(
      (c) =>
        c.includes('ampx pipeline-deploy') &&
        c.includes('$AWS_BRANCH') &&
        c.includes('$AWS_APP_ID'),
    );
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(deployIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeLessThan(deployIdx);
  });
});

describe('amplify.yml — frontend phase (Next.js build)', () => {
  const preBuild = app?.frontend?.phases?.preBuild?.commands ?? [];
  const build = app?.frontend?.phases?.build?.commands ?? [];

  it('installs workspace deps in preBuild from the monorepo root', () => {
    const hasRootInstall = preBuild.some(
      (c) => c.includes('npm ci') && (c.includes('--prefix ../') || c.includes('cd ..')),
    );
    expect(hasRootInstall).toBe(true);
  });

  it('runs `npm run build` so Amplify picks up the Next.js script', () => {
    // `appRoot: web` puts cwd inside `web/`, so a bare `npm run build`
    // invokes the `web` workspace's `next build` script — which is
    // what Amplify Hosting auto-detection expects for SSR.
    expect(build).toContain('npm run build');
  });

  it('points artifacts at the Next.js static export `out` directory relative to appRoot (#330)', () => {
    // With `appRoot: web`, baseDirectory is resolved from `web/`.
    // `out/` matches `output: 'export'` in `web/next.config.mjs` —
    // Amplify Hosting serves the resulting static bundle via the WEB
    // platform. When SSR routes land, swap to `output: 'standalone'`
    // + the Amplify Hosting Next.js framework adapter that produces
    // `.amplify-hosting/deploy-manifest.json` (WEB_COMPUTE), and
    // update this assertion to the new directory.
    expect(app?.frontend?.artifacts?.baseDirectory).toBe('out');
  });

  it('caches hoisted node_modules + the Next.js build cache', () => {
    const cachePaths = app?.frontend?.cache?.paths ?? [];
    // Hoisted deps live in the monorepo root, one level above appRoot.
    expect(cachePaths.some((p) => p.includes('node_modules'))).toBe(true);
    expect(cachePaths.some((p) => p.includes('.next/cache'))).toBe(true);
  });
});
