import { defineFunction } from '@aws-amplify/backend';

/**
 * `listSdrPublicLambda` — Lambda-backed AppSync resolver for the
 * `listSdrPublic` custom query (#286).
 *
 * Returns the public-visible SDRs with lat/lon blurred to the owner's
 * chosen `locationGranularity`. Admin callers fall through and see the
 * raw rows (so the admin propagation map can pin exact locations).
 *
 * Lambda-backed (vs. `a.handler.custom` JS) so `allow.guest()` works
 * under the identityPool default auth mode — same constraint that
 * forced `getUserPublic` to migrate to a Lambda in #271.
 *
 * Schema wiring lives in `data/models/sdr.ts`; IAM grant
 * (`SDR_TABLE_NAME` env + `dynamodb:Scan`) in `amplify/backend.ts`.
 */
export const listSdrPublicLambda = defineFunction({
  name: 'listSdrPublicLambda',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
});
