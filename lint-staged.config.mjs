// @ts-check
import path from 'node:path';

/**
 * Workspaces that own their own flat ESLint config. Order matters only for
 * readability; bucketing keys on the path prefix so there is no overlap.
 *
 * Each entry maps a workspace directory to the flat config ESLint must use for
 * files under it. ESLint flat config does NOT auto-discover a per-directory
 * config the way the legacy `.eslintrc` cascade did — invoked from the repo
 * root it would always resolve the root `eslint.config.mjs`, silently dropping
 * the workspace-specific plugins/rules (Next.js, React, Electron, Node env).
 * Passing `--config <workspace>/eslint.config.mjs` is what restores them, and
 * `tsconfigRootDir` is pinned inside each config via `import.meta.dirname`, so
 * type-aware linting stays anchored to the right workspace regardless of cwd.
 */
export const WORKSPACES = ['web', 'amplify', 'upload-client'];

/**
 * Repo-root-relative lintable files that legitimately live OUTSIDE any
 * workspace and lint against the root flat config. This is an explicit
 * allowlist — anything lintable that is neither under a workspace nor listed
 * here is treated as config drift and throws (see `bucketStagedFiles`), so a
 * `.ts`/`.tsx` file under a brand-new top-level dir can never silently lint
 * with the wrong (root) ruleset.
 */
export const ROOT_LINTABLE_ALLOWLIST = new Set([
  'eslint.config.mjs',
  'lint-staged.config.mjs',
  'lint-staged.config.test.mjs',
]);

const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const PRETTIER_ALL = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|css)$/;

/**
 * Normalise an absolute staged path to a repo-root-relative POSIX path.
 *
 * @param {string} absPath absolute path lint-staged passes in
 * @param {string} root repo root (defaults to process.cwd(), which lint-staged sets to the repo root)
 * @returns {string} relative POSIX path, e.g. `amplify/data/resource.ts`
 */
export function toRepoRelative(absPath, root = process.cwd()) {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/**
 * Bucket staged files by the workspace that owns them.
 *
 * @param {string[]} absPaths absolute staged file paths
 * @param {string} root repo root
 * @returns {{ byWorkspace: Record<string, string[]>, rootLintable: string[], prettierOnly: string[] }}
 *   `byWorkspace[ws]` holds repo-relative lintable paths owned by `ws`.
 *   `rootLintable` holds repo-relative lintable paths NOT under any workspace
 *   (root-level tooling such as `eslint.config.mjs`, `lint-staged.config.mjs`);
 *   these lint against the root flat config, which routes `.mjs`/`.cjs` through
 *   the type-unaware block so the pass stays ~1s.
 *   `prettierOnly` holds repo-relative paths that are not ESLint-lintable at all
 *   (json/md/yaml/css).
 */
export function bucketStagedFiles(absPaths, root = process.cwd()) {
  /** @type {Record<string, string[]>} */
  const byWorkspace = {};
  /** @type {string[]} */
  const rootLintable = [];
  /** @type {string[]} */
  const prettierOnly = [];

  for (const abs of absPaths) {
    const rel = toRepoRelative(abs, root);
    const ws = WORKSPACES.find((w) => rel === w || rel.startsWith(`${w}/`));

    if (LINTABLE.test(rel)) {
      if (ws) {
        (byWorkspace[ws] ??= []).push(rel);
      } else if (ROOT_LINTABLE_ALLOWLIST.has(rel)) {
        // Root-level tooling scripts keep their ESLint coverage via the root
        // flat config (cheap — no TypeScript program for `.mjs`/`.cjs`).
        rootLintable.push(rel);
      } else {
        // Config drift: a lintable file that belongs to no workspace and is
        // not an approved root-level script would otherwise fall through to
        // the root flat config and lint with the WRONG ruleset (no Next.js /
        // React / Electron / Node-env layers). Fail the commit loudly so a new
        // top-level dir gets added to WORKSPACES (or this allowlist)
        // deliberately instead of being silently mis-linted.
        throw new Error(
          `lint-staged: staged lintable file "${rel}" resolves to no workspace and is ` +
            `not in ROOT_LINTABLE_ALLOWLIST. Add its top-level dir to WORKSPACES in ` +
            `lint-staged.config.mjs (and create <dir>/eslint.config.mjs), or add the ` +
            `file to ROOT_LINTABLE_ALLOWLIST if it is a root-level tooling script.`,
        );
      }
    } else if (PRETTIER_ALL.test(rel)) {
      prettierOnly.push(rel);
    }
    // Anything else (e.g. binary assets) is ignored entirely.
  }

  return { byWorkspace, rootLintable, prettierOnly };
}

/**
 * Shell-quote a path for safe inclusion in a lint-staged command string.
 * lint-staged runs commands via a shell, so paths with spaces must be quoted.
 *
 * @param {string} p path
 * @returns {string} single-quoted path
 */
function quote(p) {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the list of commands lint-staged should run for the given staged set.
 *
 * Scoping guarantees:
 *   - ESLint runs once per affected workspace, over ONLY that workspace's
 *     staged files, using that workspace's flat config. A change touching only
 *     `amplify/**` never triggers a `web` ESLint pass and vice-versa.
 *   - `eslint .` is never used — only explicit file paths.
 *   - `--max-warnings=0` and `--fix` are preserved; prettier `--write` runs
 *     across every formattable staged file.
 *
 * @param {string[]} absPaths absolute staged file paths
 * @param {string} root repo root
 * @returns {string[]} command strings for lint-staged to execute
 */
export function buildCommands(absPaths, root = process.cwd()) {
  const { byWorkspace, rootLintable, prettierOnly } = bucketStagedFiles(absPaths, root);
  /** @type {string[]} */
  const commands = [];

  // Root-level tooling scripts (e.g. this file, `eslint.config.mjs`) lint
  // against the root flat config. `.mjs`/`.cjs` route through the root config's
  // type-unaware block, so no TypeScript program is built (~1s).
  if (rootLintable.length > 0) {
    const quoted = rootLintable.map(quote).join(' ');
    commands.push(
      `eslint --fix --max-warnings=0 --cache --cache-strategy content --cache-location .eslintcache --config eslint.config.mjs ${quoted}`,
    );
  }

  for (const ws of WORKSPACES) {
    const files = byWorkspace[ws];
    if (!files || files.length === 0) continue;
    const quoted = files.map(quote).join(' ');
    commands.push(
      // `--cache-strategy content`: the eslint cache key is the file CONTENT,
      // not its mtime. This matters because `prettier --write` (and eslint's
      // own `--fix`) rewrite the staged files and bump their mtime — under the
      // default `metadata` strategy that busts the cache on every commit,
      // forcing a full type-aware TypeScript program rebuild (~40-56s cold per
      // workspace; this monorepo's amplify program alone pulls in ~7.6k
      // node_modules .d.ts files from @aws-sdk/aws-cdk). Content keying keeps
      // the cache warm across reformatting, dropping repeat lints to ~5s.
      `eslint --fix --max-warnings=0 --cache --cache-strategy content --cache-location ${ws}/.eslintcache --config ${ws}/eslint.config.mjs ${quoted}`,
    );
  }

  // Prettier over everything formattable (workspace lintable + root-level
  // lintable + non-lintable formattable), one pass.
  const allFormattable = [...Object.values(byWorkspace).flat(), ...rootLintable, ...prettierOnly];
  if (allFormattable.length > 0) {
    commands.push(`prettier --write ${allFormattable.map(quote).join(' ')}`);
  }

  return commands;
}

/**
 * lint-staged function config. Receives the list of staged files (absolute
 * paths) and returns the array of command strings to run.
 *
 * @param {string[]} stagedFiles absolute paths of staged files
 * @returns {string[]} commands
 */
export default function lintStaged(stagedFiles) {
  return buildCommands(stagedFiles);
}
