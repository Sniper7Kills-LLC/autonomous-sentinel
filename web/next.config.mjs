/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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
