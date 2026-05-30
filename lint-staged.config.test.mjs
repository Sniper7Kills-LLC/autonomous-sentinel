// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketStagedFiles,
  buildCommands,
  toRepoRelative,
  WORKSPACES,
} from './lint-staged.config.mjs';

const ROOT = '/repo';
const abs = (rel) => `${ROOT}/${rel}`;

test('toRepoRelative normalises absolute staged paths to repo-relative POSIX', () => {
  assert.equal(toRepoRelative(abs('amplify/data/resource.ts'), ROOT), 'amplify/data/resource.ts');
});

test('bucketStagedFiles assigns files to their owning workspace', () => {
  const { byWorkspace } = bucketStagedFiles(
    [abs('amplify/data/resource.ts'), abs('web/app/page.tsx'), abs('upload-client/src/App.tsx')],
    ROOT,
  );
  assert.deepEqual(byWorkspace.amplify, ['amplify/data/resource.ts']);
  assert.deepEqual(byWorkspace.web, ['web/app/page.tsx']);
  assert.deepEqual(byWorkspace['upload-client'], ['upload-client/src/App.tsx']);
});

test('a single amplify change buckets ONLY into amplify (no web pass)', () => {
  const { byWorkspace } = bucketStagedFiles([abs('amplify/functions/transcribe/handler.ts')], ROOT);
  assert.deepEqual(Object.keys(byWorkspace), ['amplify']);
  assert.equal(byWorkspace.web, undefined);
});

test('a single web change buckets ONLY into web (no amplify pass)', () => {
  const { byWorkspace } = bucketStagedFiles([abs('web/app/layout.tsx')], ROOT);
  assert.deepEqual(Object.keys(byWorkspace), ['web']);
  assert.equal(byWorkspace.amplify, undefined);
});

test('non-lintable formattable files go to prettierOnly, not a workspace lint', () => {
  const { byWorkspace, prettierOnly } = bucketStagedFiles(
    [abs('amplify/README.md'), abs('web/styles.css'), abs('docs/notes.yaml')],
    ROOT,
  );
  assert.deepEqual(byWorkspace, {});
  assert.deepEqual(prettierOnly.sort(), ['amplify/README.md', 'docs/notes.yaml', 'web/styles.css']);
});

test('root-level lintable scripts are prettier-only (no workspace owns them)', () => {
  const { byWorkspace, prettierOnly } = bucketStagedFiles([abs('lint-staged.config.mjs')], ROOT);
  assert.deepEqual(byWorkspace, {});
  assert.deepEqual(prettierOnly, ['lint-staged.config.mjs']);
});

test('buildCommands emits one scoped eslint command per affected workspace', () => {
  const cmds = buildCommands([abs('amplify/data/resource.ts'), abs('web/app/page.tsx')], ROOT);
  const eslintCmds = cmds.filter((c) => c.startsWith('eslint '));
  assert.equal(eslintCmds.length, 2);
  assert.ok(
    eslintCmds.some(
      (c) =>
        c.includes('--config amplify/eslint.config.mjs') &&
        c.includes("'amplify/data/resource.ts'"),
    ),
  );
  assert.ok(
    eslintCmds.some(
      (c) => c.includes('--config web/eslint.config.mjs') && c.includes("'web/app/page.tsx'"),
    ),
  );
});

test('buildCommands never emits `eslint .` and always keeps --max-warnings=0', () => {
  const cmds = buildCommands([abs('amplify/data/resource.ts')], ROOT);
  for (const c of cmds.filter((x) => x.startsWith('eslint '))) {
    assert.ok(!/eslint\s+\./.test(c), `command must not lint the whole repo: ${c}`);
    assert.ok(c.includes('--max-warnings=0'), `command must keep --max-warnings=0: ${c}`);
    assert.ok(c.includes('--fix'), `command must keep --fix: ${c}`);
  }
});

test('eslint commands use content-strategy caching in the workspace cache dir', () => {
  // Content keying keeps the type-aware cache warm across prettier/--fix
  // rewrites; the per-workspace cache dir lets CI (`npm -w <ws> run lint`)
  // and the pre-commit hook share one warm cache.
  const cmds = buildCommands([abs('amplify/data/resource.ts')], ROOT).filter((c) =>
    c.startsWith('eslint '),
  );
  for (const c of cmds) {
    assert.ok(c.includes('--cache-strategy content'), `must use content cache strategy: ${c}`);
    assert.ok(
      c.includes('--cache-location amplify/node_modules/.cache/eslint/'),
      `must cache in the workspace dir: ${c}`,
    );
  }
});

test('buildCommands runs a single prettier pass across all formattable staged files', () => {
  const cmds = buildCommands(
    [abs('amplify/data/resource.ts'), abs('web/styles.css'), abs('docs/x.md')],
    ROOT,
  );
  const prettierCmds = cmds.filter((c) => c.startsWith('prettier --write'));
  assert.equal(prettierCmds.length, 1);
  assert.ok(prettierCmds[0].includes("'amplify/data/resource.ts'"));
  assert.ok(prettierCmds[0].includes("'web/styles.css'"));
  assert.ok(prettierCmds[0].includes("'docs/x.md'"));
});

test('a single-file amplify change produces exactly one eslint + one prettier command', () => {
  const cmds = buildCommands([abs('amplify/data/resource.ts')], ROOT);
  assert.equal(cmds.filter((c) => c.startsWith('eslint ')).length, 1);
  assert.equal(cmds.filter((c) => c.startsWith('prettier --write')).length, 1);
});

test('WORKSPACES matches the npm workspaces declared in the monorepo', () => {
  assert.deepEqual([...WORKSPACES].sort(), ['amplify', 'upload-client', 'web']);
});
