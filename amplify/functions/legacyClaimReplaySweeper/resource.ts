import { defineFunction } from '@aws-amplify/backend';

/**
 * `legacyClaimReplaySweeper` — daily EventBridge cron that finishes any
 * legacy-claim work the per-signup `legacyClaimWorker` (#272 / #273)
 * didn't complete. See `handler.ts` for the strategy.
 *
 * Schedule + IAM grants live in `amplify/backend.ts`. 60 s timeout gives
 * the iteration room across modestly-sized claim backlogs; 256 MB
 * matches the workers since the shape is the same (Query / TransactWriteItems).
 */
export const legacyClaimReplaySweeper = defineFunction({
  name: 'legacyClaimReplaySweeper',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 256,
});
