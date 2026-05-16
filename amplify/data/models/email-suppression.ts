import { a } from '@aws-amplify/backend';

/**
 * EmailSuppression — bounce + complaint suppression list (#249).
 *
 * Populated automatically by the SES bounce / complaint SNS handler Lambda
 * (issue #250 — out of scope here) and consulted by the email-send Lambda
 * (issue #128) before fanning out. Sending to bouncing / complaining
 * addresses tanks our SES sending reputation, so the lookup is mandatory
 * on every outbound.
 *
 * `email` is the identifier — at most one row per address. Repeated soft
 * bounces increment `occurrences` and refresh `lastSeenAt`; a hard bounce
 * or complaint immediately writes / upgrades the row. Admin-only authz
 * because the only legitimate callers are admin-role Lambdas and the
 * admin UI (for manual opt-out entries).
 *
 * Custom operations defined alongside:
 *   - `suppressEmail` mutation (upsert)
 *   - `isSuppressed` query (lookup)
 *
 * Resolver source lives under ./resolvers/ — pure JS pipeline resolvers,
 * no Lambda. Logic-level tests in ./resolvers/*.test.ts, schema-shape
 * tests in ./email-suppression.test.ts.
 *
 * Deferred to follow-ups:
 *   - Bounce / complaint Lambda — issue #250.
 *   - Email-send Lambda integration — issue #128.
 *   - Re-engagement / opt-out release admin UI — phase 4.
 */
export const EmailSuppression = a
  .model({
    email: a.string().required(),
    reason: a.enum(['HARD_BOUNCE', 'SOFT_BOUNCE_REPEATED', 'COMPLAINT', 'MANUAL']),
    bounceType: a.string(),
    firstSeenAt: a.datetime(),
    lastSeenAt: a.datetime(),
    occurrences: a.integer().default(1),
    notes: a.string(),
  })
  .identifier(['email'])
  .secondaryIndexes((i) => [i('reason').sortKeys(['lastSeenAt'])])
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);

/**
 * `suppressEmail` — upsert a suppression row.
 *
 * Called by the bounce / complaint Lambda for SES SNS notifications and
 * by admins for manual opt-out entries. Idempotent: `firstSeenAt` is
 * preserved across calls (`if_not_exists`), `lastSeenAt` is refreshed
 * every time, and `occurrences` accumulates via DDB `ADD`, so repeated
 * soft-bounce events for the same address increment the counter without
 * losing history.
 */
export const suppressEmail = a
  .mutation()
  .arguments({
    email: a.string().required(),
    reason: a.ref('SuppressionReason').required(),
    bounceType: a.string(),
    notes: a.string(),
  })
  .returns(a.ref('EmailSuppression'))
  .authorization((allow) => allow.groups(['admin']))
  .handler(
    a.handler.custom({
      dataSource: a.ref('EmailSuppression'),
      entry: './resolvers/suppress-email.js',
    }),
  );

/**
 * `isSuppressed` — boolean lookup keyed on email.
 *
 * The email-send Lambda hits this on every outbound message. Returns
 * true if a row exists, false otherwise. Eventually-consistent read is
 * fine; see resolver comment for rationale.
 */
export const isSuppressed = a
  .query()
  .arguments({ email: a.string().required() })
  .returns(a.boolean())
  .authorization((allow) => allow.groups(['admin']))
  .handler(
    a.handler.custom({
      dataSource: a.ref('EmailSuppression'),
      entry: './resolvers/is-suppressed.js',
    }),
  );

/**
 * Shared enum so the mutation argument and the model field stay in
 * lockstep. AppSync requires enum args to be addressable types; we
 * register this on the schema and `a.ref` it from `suppressEmail`.
 */
export const SuppressionReason = a.enum([
  'HARD_BOUNCE',
  'SOFT_BOUNCE_REPEATED',
  'COMPLAINT',
  'MANUAL',
]);
