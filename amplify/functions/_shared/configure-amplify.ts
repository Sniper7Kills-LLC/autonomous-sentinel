import { Amplify } from 'aws-amplify';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';

/**
 * Lambda runtime has no auto-config like the browser. Calling
 * `generateClient()` from `aws-amplify/data` without first running
 * `Amplify.configure(...)` throws either:
 *
 *   "Client could not be generated. This is likely due to
 *    Amplify.configure() not being called prior to generateClient()."
 *
 * …or once configured but without the model-introspection schema:
 *
 *   "Cannot read properties of undefined (reading
 *    'listRecordingByContentHash')"
 *
 * The Amplify-Gen-2-provided helper `getAmplifyDataClientConfig`
 * solves both: it reads the auto-resolved Lambda env vars
 * (`AMPLIFY_DATA_GRAPHQL_ENDPOINT`, `AMPLIFY_DATA_MODEL_INTROSPECTION_SCHEMA_BUCKET_NAME`,
 * `AMPLIFY_DATA_MODEL_INTROSPECTION_SCHEMA_KEY`,
 * `AMPLIFY_DATA_DEFAULT_NAME`, plus the standard `AWS_*` credential
 * envs), fetches the model-introspection JSON from S3 once, and
 * returns the `resourceConfig` + `libraryOptions` to pass to
 * `Amplify.configure`.
 *
 * **The Lambda must be granted resource access in the schema** via
 *
 *   a.schema(...).authorization((allow) => [allow.resource(fn)])
 *
 * or the auto-resolved env vars are never injected and this helper
 * will throw at startup.
 *
 * Idempotent across cold-start reuse — once configured, subsequent
 * calls are no-ops.
 */
let configured = false;

export async function configureAmplifyOnce(): Promise<void> {
  if (configured) return;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
    process.env as Parameters<typeof getAmplifyDataClientConfig>[0],
  );
  Amplify.configure(resourceConfig, libraryOptions);
  configured = true;
}

/**
 * Test-only reset. Lets unit-test fixtures undo the module-level
 * `configured` flag so a second `configureAmplifyOnce()` call
 * actually invokes the configuration again.
 */
export function __resetForTests(): void {
  configured = false;
}
