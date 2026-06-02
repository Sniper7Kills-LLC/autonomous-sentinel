import { defineFunction } from '@aws-amplify/backend';

/**
 * `stripeRevenueWorker` — STUB (#303, deferral tracked under #206 / #208).
 *
 * Will eventually run on the same daily cadence as `costSnapshotWorker`
 * to pull Stripe Charges + Subscriptions and write `REVENUE_*`
 * RevenueSnapshot rows for the `/transparency` revenue panel.
 *
 * Per CLAUDE.md (Donations / Paid Tier: "Stripe wiring deferred until
 * first paid feature actually ships"), the handler currently logs and
 * exits — it makes NO Stripe SDK call and writes NOTHING. The cron +
 * function exist so the wiring is in place; the RevenueSnapshot table
 * stays empty and the panel shows "no revenue data yet" until Stripe
 * lands.
 *
 * `resourceGroupName: 'data'` matches the other data-stack workers to
 * stay clear of the function ↔ auth ↔ data nested-stack cycle (#317),
 * even though the stub touches nothing yet — it keeps the eventual
 * RevenueSnapshot write in the right stack from day one.
 */
export const stripeRevenueWorker = defineFunction({
  name: 'stripeRevenueWorker',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 256,
  resourceGroupName: 'data',
});
