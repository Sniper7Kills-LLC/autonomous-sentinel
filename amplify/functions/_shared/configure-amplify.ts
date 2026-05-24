import { Amplify } from 'aws-amplify';

/**
 * Lambda runtime has no auto-config like the browser — calling
 * `generateClient()` from `aws-amplify/data` without first running
 * `Amplify.configure(...)` throws:
 *
 *   "Client could not be generated. This is likely due to
 *    Amplify.configure() not being called prior to generateClient()
 *    or because the configuration passed to Amplify.configure() is
 *    missing GraphQL provider configuration."
 *
 * Amplify Gen 2 wires the data-API endpoint into every backend Lambda
 * via the auto-resolved env var `AMPLIFY_DATA_GRAPHQL_ENDPOINT`. The
 * region comes from the standard `AWS_REGION` env var.
 *
 * Calling this helper at module load on every Lambda that calls
 * `generateClient` keeps the call site identical to the existing
 * pattern (no need to import Amplify per file). Idempotent across
 * cold-start reuse.
 */
let configured = false;

export function configureAmplifyOnce(): void {
  if (configured) return;
  const endpoint = process.env.AMPLIFY_DATA_GRAPHQL_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'configureAmplifyOnce: AMPLIFY_DATA_GRAPHQL_ENDPOINT env var is required (Amplify Gen 2 auto-resolves this on every backend Lambda — missing means the Lambda is not wired through `defineBackend`)',
    );
  }
  Amplify.configure({
    API: {
      GraphQL: {
        endpoint,
        region: process.env.AWS_REGION ?? 'us-east-1',
        defaultAuthMode: 'iam',
      },
    },
  });
  configured = true;
}

/**
 * Test-only reset. Lets unit-test fixtures undo the module-level
 * `configured` flag so a second `configureAmplifyOnce()` call
 * actually invokes `Amplify.configure` again.
 */
export function __resetForTests(): void {
  configured = false;
}
