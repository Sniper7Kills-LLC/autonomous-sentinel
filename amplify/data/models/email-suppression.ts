import { a } from '@aws-amplify/backend';

/**
 * EmailSuppression — bounce + complaint suppression list (#249).
 *
 * Populated automatically by the SES bounce / complaint SNS handler Lambda
 * (separate phase-5 issue) and consulted by the email-send Lambda before
 * fanning out. Sending to bouncing / complaining addresses tanks our SES
 * sending reputation, so this check is mandatory on every outbound.
 *
 * `email` is the identifier — at most one row per address. Repeated soft
 * bounces increment `occurrences` and refresh `lastSeenAt`; a hard bounce or
 * complaint immediately writes/upgrades the row.
 *
 * Deferred:
 *   - `suppressEmail` custom mutation (called by bounce / complaint Lambda).
 *   - `isSuppressed` custom query (called by email-send Lambda).
 *   - Re-engagement / opt-out release admin UI (phase 4).
 */
export const EmailSuppression = a
  .model({
    email: a.string().required(),
    reason: a.enum([
      'HARD_BOUNCE',
      'SOFT_BOUNCE_REPEATED',
      'COMPLAINT',
      'MANUAL',
    ]),
    bounceType: a.string(),
    firstSeenAt: a.datetime(),
    lastSeenAt: a.datetime(),
    occurrences: a.integer().default(1),
    notes: a.string(),
  })
  .identifier(['email'])
  .secondaryIndexes((i) => [i('reason').sortKeys(['lastSeenAt'])])
  .authorization((allow) => [
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
