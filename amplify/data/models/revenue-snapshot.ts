import { a } from '@aws-amplify/backend';

/**
 * RevenueSnapshot — daily Stripe revenue rows for the `/transparency`
 * page revenue panel (#303).
 *
 * Standalone twin of `CostSnapshot`. Kept separate so the authorization
 * split between public cost rows and gated revenue rows is model-level
 * (no custom resolver filtering by category prefix → no extra CFN
 * surface; #317). Revenue is admin/moderator only for v1; the public
 * sees only the cost side.
 *
 * Rows are written by `stripeRevenueWorker`. Per CLAUDE.md (Donations /
 * Paid Tier: "Stripe wiring deferred until first paid feature actually
 * ships"), that worker is a STUB for now — it writes nothing live and
 * makes no Stripe SDK call (#206 / #208). This model therefore stays
 * empty until Stripe lands; the panel renders "no revenue data yet".
 *
 * Field shape mirrors CostSnapshot:
 *   - category REVENUE_DONATION     → subject = "one-time" / amount band
 *   - category REVENUE_SUBSCRIPTION → subject = tier name (e.g. "Tier 1")
 *   - meta carries drill-down (charge count, MRR, active subscriber count)
 *
 * Authz: moderator + admin read; admin write. No guest / authenticated
 * read — revenue is gated.
 */
export const RevenueSnapshot = a
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
    // A group may appear in only ONE allow.groups rule (Amplify rejects a
    // duplicate @auth directive for the same group — synth-time error that
    // CI lint/typecheck/test do NOT catch). So admin gets one full-perm
    // rule and moderator one read rule, rather than listing admin twice.
    allow.groups(['moderator']).to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
