import { defineFunction } from '@aws-amplify/backend';

/**
 * Deploy-status badge Lambda (#423).
 *
 * Public, unauthenticated Function URL. Returns shields.io endpoint
 * JSON describing the most recent Amplify Hosting deploy job for the
 * `main` branch. README renders the badge by pointing
 * `https://img.shields.io/endpoint?url=<function-url>` at this Lambda.
 *
 * Grouped with `data` (not `auth`) so the IAM grant + env-var wiring
 * for the Amplify SDK in `backend.ts` doesn't recreate the
 * auth → data cross-stack edge that closed the CFN cycle in #420 /
 * #424. The function doesn't touch DynamoDB; `data` is just a
 * convenient existing stack to land in.
 *
 * Cold-start cost is irrelevant: shields.io caches the rendered SVG
 * for 5 minutes, the handler also emits its own `cacheSeconds: 300`
 * hint, and the Function URL response sets `Cache-Control: public,
 * max-age=300`. Even at heavy README traffic, that bounds invocations
 * to ~288/day.
 */
export const deployBadge = defineFunction({
  name: 'deployBadge',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
  resourceGroupName: 'data',
  environment: {
    // Wired in `amplify/backend.ts`.
    AMPLIFY_APP_ID: '',
    AMPLIFY_BRANCH: 'main',
  },
});
