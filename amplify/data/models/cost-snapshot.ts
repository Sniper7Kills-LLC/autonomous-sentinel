import { a } from '@aws-amplify/backend';
import { costSnapshotTrigger } from '../../functions/costSnapshotTrigger/resource';

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
 * `runCostSnapshotNow` — admin on-demand cost-sync (#644).
 *
 * Bound to `costSnapshotTrigger`, NOT the worker. The worker cannot be an
 * AppSync resolver in this stack without closing a FunctionDirectiveStack ↔
 * data CloudFormation circular dependency (proven across 6 failed deploys).
 * The trigger is the resolver and only does one `sqs:SendMessage` to the
 * cost-snapshot queue; the worker consumes that queue as an SQS event source
 * (an event source, not a resolver), so it never enters the
 * FunctionDirectiveStack. Mirrors the proven
 * `postConfirmation → legacyClaimQueue → legacyClaimWorker` SQS hand-off.
 *
 * Admin-only. Returns `{ status: 'queued' }` immediately; the admin refetches
 * the CostSnapshot rows ~1 min later to see the fresh snapshot.
 */
export const runCostSnapshotNow = a
  .mutation()
  .returns(a.json())
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(costSnapshotTrigger));
