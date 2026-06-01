import { a } from '@aws-amplify/backend';

/**
 * BudgetConfig — admin-tunable AWS Budget thresholds + per-tier actions (#116).
 *
 * Single config row keyed by `key` (singleton, e.g. `"default"`). Records the
 * INTENDED budget thresholds + notification recipient + per-tier actions that
 * mirror CLAUDE.md → Stack → Budgets:
 *   - $50/mo soft  → email
 *   - $100/mo loud → email + admin banner
 *   - $200/mo hard → throttle Whisper concurrency + page admin
 *
 * Honest framing: the LIVE AWS Budget is defined in CDK (`amplify/budgets.ts`)
 * from the `AS_BUDGET_SOFT_USD` / `AS_BUDGET_LOUD_USD` / `AS_BUDGET_HARD_USD` +
 * `AS_BUDGET_NOTIFICATION_EMAIL` env vars at DEPLOY time — it cannot read
 * DynamoDB at runtime. This model therefore only RECORDS the operator's
 * intended values. Pushing them into the env vars + redeploying (the sync
 * step) and live month-to-date spend display (Cost Explorer, #303) are both
 * DEFERRED — see the admin editor note.
 *
 * Standalone model — no relations, no authz changes elsewhere (keeps the CFN
 * graph acyclic). Authz is admin-only (these are admin knobs). Revision
 * history is captured by AuditLog (#38) entries — no per-key history table.
 */
export const BudgetConfig = a
  .model({
    key: a.string().required(),
    softUsd: a.integer().default(50),
    loudUsd: a.integer().default(100),
    hardUsd: a.integer().default(200),
    notificationEmail: a.string(),
    softBannerEnabled: a.boolean().default(false),
    loudBannerEnabled: a.boolean().default(true),
    hardThrottleEnabled: a.boolean().default(true),
    hardPageEnabled: a.boolean().default(true),
    updatedById: a.id(),
    notes: a.string(),
  })
  .identifier(['key'])
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);
