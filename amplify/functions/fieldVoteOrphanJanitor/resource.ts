import { defineFunction } from '@aws-amplify/backend';

/**
 * `fieldVoteOrphanJanitor` — daily / weekly EventBridge cron that
 * sweeps FieldVote rows whose `messageId` no longer resolves (#270).
 * Schedule + IAM grants in `amplify/backend.ts`.
 *
 * 120 s timeout covers the full-table Scan on small-to-moderate
 * corpora; bump if the table grows past ~100k rows. 256 MB matches
 * the other workers since the per-page workload is the same shape
 * (Scan → BatchGetItem → BatchWriteItem).
 */
export const fieldVoteOrphanJanitor = defineFunction({
  name: 'fieldVoteOrphanJanitor',
  entry: './handler.ts',
  timeoutSeconds: 120,
  memoryMB: 256,
});
