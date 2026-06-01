import { execSync } from 'node:child_process';

/**
 * Build identifier surfaced in the site footer. Prefer Amplify Hosting's
 * `AWS_COMMIT_ID` (set during the managed build); fall back to the local
 * git short SHA for dev / CI `next build`; finally `dev` if git is
 * unavailable. Injected as a public env var so it inlines into the
 * client bundle at build time — never hardcoded in source.
 */
function resolveBuildSha() {
  const fromAmplify = process.env.AWS_COMMIT_ID;
  if (fromAmplify) return fromAmplify.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_BUILD_SHA: resolveBuildSha(),
  },
  // `output: 'export'` emits a fully-static `out/` directory at
  // `next build` time. Amplify Hosting Gen 2's WEB platform serves
  // it as static content with no compute primitive — the format
  // matches what Amplify expects without needing the
  // `.amplify-hosting/deploy-manifest.json` adapter output that
  // WEB_COMPUTE requires (#330).
  //
  // When the first SSR route / API route / server action actually
  // lands, swap to `output: 'standalone'` + wire the Amplify
  // Hosting Next.js framework adapter so deploys produce a proper
  // `.amplify-hosting/` bundle. Track the upgrade as a follow-up
  // on #330. For v0 scaffolding (single static homepage), static
  // export is the lowest-risk deploy path.
  output: 'export',
};

export default nextConfig;
