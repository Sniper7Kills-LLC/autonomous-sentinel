import { defineFunction } from '@aws-amplify/backend';

/**
 * `legacyClaimWorker` — async-invoked Lambda that performs the legacy
 * account User-row PK rewrite off the synchronous Cognito sign-up path
 * (sub-A of #16, #272).
 *
 * `postConfirmation` async-invokes this Lambda (`InvocationType: 'Event'`)
 * on a legacy-email match so the user's sign-up does not block on the
 * DDB transact + audit write. The worker re-queries the legacy row
 * server-side (avoids trusting stale payload) and runs
 * `linkLegacyClaim` against the real DDB TransactWriteItems API.
 *
 * IAM grants + table-name env var are wired in `amplify/backend.ts`:
 *   - `USER_TABLE_NAME` (env)            — Amplify-generated table name
 *   - `dynamodb:TransactWriteItems`     — on the User table
 *   - AppSync read (`listUserByEmail`)  — via Amplify Data IAM
 *
 * 30 s timeout leaves room for one DDB throttle retry; 256 MB matches
 * `userMutations` since the workload is the same shape (two writes +
 * Amplify Data cold start).
 */
export const legacyClaimWorker = defineFunction({
  name: 'legacyClaimWorker',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
});
