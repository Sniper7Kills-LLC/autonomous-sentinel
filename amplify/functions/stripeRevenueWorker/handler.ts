import type { Handler, ScheduledEvent } from 'aws-lambda';

/**
 * `stripeRevenueWorker` — STUB handler (#303; deferral #206 / #208).
 *
 * Does nothing live: no Stripe SDK call, no RevenueSnapshot write. When
 * the Stripe integration ships this will pull Charges + Subscriptions
 * and write `REVENUE_DONATION` / `REVENUE_SUBSCRIPTION` rows on the
 * daily cron. Until then it logs and exits so the cron wiring is proven
 * but produces no data — the revenue panel renders "no revenue data
 * yet".
 */
export const handler: Handler<ScheduledEvent, void> = async () => {
  await Promise.resolve();
  console.info(
    'stripeRevenueWorker: stub — Stripe revenue ingestion deferred until donations ship (#206/#208); no rows written',
  );
};
