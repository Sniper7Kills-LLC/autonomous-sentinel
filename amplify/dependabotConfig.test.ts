import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Dependabot configuration contract (#369).
 *
 * The monorepo has three npm workspaces (`web/`, `amplify/`,
 * `upload-client/`) plus a root `package.json`, and one GitHub Actions
 * workflow set. Dependabot must scan all four npm scopes and the
 * Actions workflows; missing any one means a workspace silently goes
 * un-updated and its lockfile drifts.
 */

interface DependabotConfig {
  version?: number;
  updates?: DependabotUpdate[];
}

interface DependabotUpdate {
  'package-ecosystem'?: string;
  directory?: string;
  directories?: readonly string[];
  schedule?: { interval?: string };
  groups?: Record<string, unknown>;
}

const configPath = resolve(__dirname, '..', '.github', 'dependabot.yml');
const config = parse(readFileSync(configPath, 'utf8')) as DependabotConfig;
const updates = config.updates ?? [];

function findUpdate(ecosystem: string, directory: string): DependabotUpdate | undefined {
  return updates.find(
    (u) =>
      u['package-ecosystem'] === ecosystem &&
      (u.directory === directory || (u.directories ?? []).includes(directory)),
  );
}

describe('dependabot.yml — top level', () => {
  it('declares schema version 2', () => {
    expect(config.version).toBe(2);
  });

  it('declares at least one update entry', () => {
    expect(updates.length).toBeGreaterThan(0);
  });
});

describe('dependabot.yml — npm ecosystem coverage', () => {
  it.each([
    ['/', 'root workspace'],
    ['/web', 'web workspace'],
    ['/amplify', 'amplify workspace'],
    ['/upload-client', 'upload-client workspace'],
  ])('scans %s (%s)', (directory) => {
    expect(findUpdate('npm', directory)).toBeDefined();
  });
});

describe('dependabot.yml — github-actions ecosystem', () => {
  it('scans the workflow root', () => {
    expect(findUpdate('github-actions', '/')).toBeDefined();
  });
});

describe('dependabot.yml — schedule + grouping', () => {
  it('schedules every update at most weekly (no daily noise)', () => {
    for (const u of updates) {
      expect(u.schedule?.interval, `entry for ${u['package-ecosystem']} ${u.directory}`).toMatch(
        /^(weekly|monthly)$/,
      );
    }
  });

  it('groups minor + patch updates on every npm entry to cut PR noise', () => {
    const npmEntries = updates.filter((u) => u['package-ecosystem'] === 'npm');
    for (const u of npmEntries) {
      expect(u.groups, `entry for ${u.directory} missing groups`).toBeDefined();
      const groupValues = Object.values(u.groups ?? {});
      const hasMinorPatchGroup = groupValues.some((g) => {
        const types = extractUpdateTypes(g);
        return types.includes('minor') && types.includes('patch');
      });
      expect(hasMinorPatchGroup, `entry for ${u.directory} missing minor+patch group`).toBe(true);
    }
  });

  it('never groups major bumps — each major version PR must stand alone for review', () => {
    // Grouping a major into the same PR as minors/patches hides the
    // breaking-change diff behind a wall of safe bumps. Majors must open
    // their own PRs so they get individual review. The test guards
    // against a future careless edit that adds `major` to a group.
    for (const u of updates) {
      for (const [groupName, group] of Object.entries(u.groups ?? {})) {
        const types = extractUpdateTypes(group);
        expect(
          types,
          `group '${groupName}' on ${u['package-ecosystem']} ${u.directory} must not include 'major'`,
        ).not.toContain('major');
      }
    }
  });
});

function extractUpdateTypes(group: unknown): readonly string[] {
  if (typeof group !== 'object' || group === null) return [];
  const candidate = (group as Record<string, unknown>)['update-types'];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((t): t is string => typeof t === 'string');
}
