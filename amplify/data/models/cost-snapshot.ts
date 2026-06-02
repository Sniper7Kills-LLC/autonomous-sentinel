import { a } from '@aws-amplify/backend';
import { costSnapshotWorker } from '../../functions/costSnapshotWorker/resource';

/**
 * CostSnapshot — daily AWS spend rows for the public `/transparency`
 * page (#303).
 *
 * Open-source operations promise: users can see what running eam.watch
 * costs Sniper7Kills LLC. This model holds the cost side only — AWS
 * service spend, S3-prefix storage breakdowns, and per-Lambda compute
 * lines. Revenue (Stripe) lives in the separate, gated `RevenueSnapshot`
 * model so the public/revenue authorization split is model-level (no
 * custom resolver that filters by category prefix → no extra CFN
 * surface / nested-stack cycle risk; #317).
 *
 * Rows are written daily by `costSnapshotWorker` (05:00 UTC cron). One
 * row per (snapshotDate, subject):
 *   - category AWS_SERVICE     → subject = service name (e.g. "AWS Lambda")
 *   - category S3_PREFIX       → subject = prefix path  (e.g. "recordings/originals/")
 *   - category LAMBDA_FUNCTION → subject = function name
 *
 * `meta` carries drill-down values (invocations, GB-seconds, bytes,
 * object counts) as free-form JSON so the page can explain a line item
 * without a schema migration per metric.
 *
 * Identifier is the composite `(snapshotDate, subject)` so multiple
 * rows per date coexist and a re-run of the worker for the same date
 * idempotently overwrites the prior row.
 *
 * Authz: public-readable (this is the whole point of the page). Guests
 * + authenticated users read; only admins write (the worker writes via
 * its own IAM execution role through the DDB SDK, not through AppSync,
 * so the admin-write rule only governs human/admin-UI writes).
 */
export const CostSnapshot = a
  .model({
    snapshotDate: a.string().required(),
    subject: a.string().required(),
    category: a.string().required(),
    usdAmount: a.float(),
    unit: a.string(),
    meta: a.json(),
  })
  .identifier(['snapshotDate', 'subject'])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);

/**
 * `runCostSnapshotNow` — admin-only on-demand cost-snapshot sync (#644).
 *
 * Bound DIRECTLY to the existing `costSnapshotWorker` Lambda as its AppSync
 * resolver — NO separate trigger Lambda, NO SQS queue, and NO second
 * EventBridge rule (the second rule + cross-stack ARN imports were what
 * previously cycled CloudFormation). The worker self-detects the invocation
 * source: the 05:00 cron path returns void, while this mutation path returns
 * a `{ snapshotDate, rowsWritten, totalUsd }` JSON summary for the admin UI.
 *
 * The function's data-stack IAM grant is wired in `data/resource.ts`'s
 * schema-level `allow.resource(costSnapshotWorker)` block; the AWS-service
 * grants (Cost Explorer, CloudWatch, S3 wildcard, CostSnapshot writes via
 * grantWriteData) live in `amplify/backend.ts`.
 */
export const runCostSnapshotNow = a
  .mutation()
  .returns(a.json())
  .authorization((allow) => allow.groups(['admin']))
  .handler(a.handler.function(costSnapshotWorker));
