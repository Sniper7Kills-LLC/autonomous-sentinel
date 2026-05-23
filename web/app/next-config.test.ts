import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Pin Next.js build mode (#330).
 *
 * `web/next.config.mjs` must set `output: 'export'` so `next build`
 * emits a fully-static `out/` directory that Amplify Hosting's WEB
 * platform serves directly. The companion test in
 * `amplify/amplifyHostingBuildSpec.test.ts` pins `baseDirectory:
 * out` in `amplify.yml`. Both halves of the contract must move
 * together when the SSR upgrade lands (swap to `output:
 * 'standalone'` + wire the Amplify Hosting Next.js framework
 * adapter that emits `.amplify-hosting/deploy-manifest.json`,
 * then switch the Amplify app platform back to `WEB_COMPUTE`).
 *
 * Read the source file directly rather than importing it — the
 * config is an ESM module with a side-effecting default export;
 * a regex on the source text is the simplest stable assertion.
 */

const NEXT_CONFIG_PATH = resolve(__dirname, '..', 'next.config.mjs');

describe('web/next.config.mjs', () => {
  it("declares `output: 'export'` so Amplify Hosting WEB platform receives a static `out/` bundle (#330)", () => {
    const source = readFileSync(NEXT_CONFIG_PATH, 'utf8');
    // Tolerate single OR double quotes + arbitrary whitespace
    // around the colon so a prettier reformat does not break the
    // pin.
    expect(source).toMatch(/output\s*:\s*['"]export['"]/);
  });
});
