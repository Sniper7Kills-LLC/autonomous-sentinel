import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Theming guard (#698): every `var(--token)` referenced from a component CSS
 * module must resolve to a custom property actually defined in globals.css.
 *
 * Relying on the hardcoded fallback (`var(--token, #1b1b1b)`) silently breaks
 * theming — the fallback is theme-blind, so an undefined token name pins the
 * value to one theme. That is exactly how the admin forms went black in the
 * light theme: they referenced `--surface` / `--border` (which never existed)
 * instead of `--color-surface-2` / `--color-border`.
 */

const WEB_ROOT = path.resolve(__dirname, '..', '..');

// Custom properties injected at runtime by next/font (layout.tsx), never in CSS.
const RUNTIME_INJECTED = new Set(['--font-atkinson', '--font-jb-mono']);

/** Drop CSS block comments so commented-out token defs/refs don't skew the scan. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readGlobals(): string {
  return stripComments(readFileSync(path.join(WEB_ROOT, 'app', 'globals.css'), 'utf8'));
}

/** Collect every `--name:` declaration (a definition, not a `var()` use). */
function definedTokens(css: string): Set<string> {
  const defs = new Set<string>();
  const re = /(--[a-zA-Z0-9-]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const [, name] = m;
    if (name) defs.add(name);
  }
  return defs;
}

/**
 * Collect every `var(--name, fallback?)` reference along with whether its
 * fallback contains another `var(...)`. A var-fallback (e.g. `var(--card-stripe,
 * var(--color-accent))` or `var(--x, color-mix(in srgb, var(--y), transparent))`)
 * is an intentional, theme-aware override hook and is allowed even when the
 * primary token is undefined. A purely literal fallback — or no fallback at all —
 * pins the value to one theme (or drops it), which is the bug.
 */
function referencedTokens(css: string): { token: string; varFallback: boolean }[] {
  const refs: { token: string; varFallback: boolean }[] = [];
  const re = /var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^)]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const [, token, rawFallback] = m;
    if (!token) continue;
    const fallback = (rawFallback ?? '').trim();
    refs.push({ token, varFallback: fallback.includes('var(') });
  }
  return refs;
}

function walkCssModules(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'out') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCssModules(full, acc);
    } else if (entry.name.endsWith('.module.css')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('CSS custom-property tokens', () => {
  const defined = definedTokens(readGlobals());

  it('globals.css defines the core color tokens', () => {
    expect(defined.has('--color-bg')).toBe(true);
    expect(defined.has('--color-surface-2')).toBe(true);
    expect(defined.has('--color-border')).toBe(true);
  });

  it('every var(--token) in component CSS resolves to a defined token', () => {
    const modules = [
      ...walkCssModules(path.join(WEB_ROOT, 'components')),
      ...walkCssModules(path.join(WEB_ROOT, 'app')),
    ];

    const violations: string[] = [];
    for (const file of modules) {
      const css = readFileSync(file, 'utf8');
      for (const { token, varFallback } of referencedTokens(css)) {
        if (defined.has(token) || RUNTIME_INJECTED.has(token) || varFallback) continue;
        violations.push(`${path.relative(WEB_ROOT, file)}: undefined ${token}`);
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
