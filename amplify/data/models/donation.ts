import { a } from '@aws-amplify/backend';

/**
 * Donation — Stripe-backed donations + recurring subscriptions (#40).
 *
 * One-time + three recurring tiers. Stripe webhook Lambda is the only writer;
 * clients are read-only. `badgeExpiresAt` is computed server-side per the
 * CLAUDE.md formula (`days = max(30, round(60 * log2(amountCents/100 + 1)))`).
 * Recurring renewals extend the expiry; cancellation truncates to the end of
 * the paid period.
 *
 * Deferred:
 *   - Webhook Lambda handler (phase 9 #160).
 *   - Banned-user gate at Stripe Checkout (phase 9 #161).
 */
export const Donation = a
  .model({
    // Cognito sub of the donor — `User.id = cognitoSub` (#259).
    userId: a.id().required(),
    user: a.belongsTo('User', 'userId'),
    type: a.enum([
      'ONE_TIME',
      'RECURRING_TIER_1',
      'RECURRING_TIER_2',
      'RECURRING_TIER_3',
    ]),
    amountCents: a.integer().required(),
    coverFee: a.boolean().default(false),
    stripePaymentIntentId: a.string(),
    stripeSubscriptionId: a.string(),
    stripeCheckoutSessionId: a.string(),
    badgeExpiresAt: a.datetime(),
    state: a.enum([
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'REFUNDED',
      'CANCELLED',
    ]),
    occurredAt: a.datetime(),
  })
  .secondaryIndexes((i) => [
    i('userId').sortKeys(['occurredAt']),
    i('stripeSubscriptionId'),
  ])
  .authorization((allow) => [
    // Donor = the Cognito sub stored in `userId` (#259).
    allow.ownerDefinedIn('userId').identityClaim('sub').to(['read']),
    allow.groups(['admin']).to(['read']),
    // Writes flow through the Stripe webhook Lambda only (no client surface).
  ]);
