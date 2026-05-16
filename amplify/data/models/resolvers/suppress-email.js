/**
 * AppSync JS resolver for the `suppressEmail` custom mutation (issue #249).
 *
 * Upserts a row into the EmailSuppression table:
 *   - HARD_BOUNCE / COMPLAINT / MANUAL — write the row, set reason +
 *     bounceType + notes, refresh lastSeenAt, ADD 1 to occurrences.
 *   - SOFT_BOUNCE_REPEATED — same shape; occurrences keeps climbing on
 *     each repeated soft-bounce notification so the bounce handler Lambda
 *     can decide when to promote the address to a permanent suppression.
 *
 * The atomicity matters: SES can deliver duplicate / overlapping bounce
 * + complaint notifications for the same address. Using a single
 * UpdateItem with `if_not_exists` on firstSeenAt + `ADD` on occurrences
 * means concurrent writers don't trample each other.
 *
 * This file is shipped as-is to AppSync (APPSYNC_JS runtime 1.0.0). The
 * runtime doesn't transpile — keep this JS, no TypeScript syntax. Types
 * are documented via JSDoc and pinned by `./suppress-email.test.ts`.
 *
 * The bounce / complaint Lambda itself (issue #250) is out of scope for
 * #249.
 */

/**
 * @typedef {'HARD_BOUNCE' | 'SOFT_BOUNCE_REPEATED' | 'COMPLAINT' | 'MANUAL'} SuppressionReason
 *
 * @typedef {Object} SuppressEmailArgs
 * @property {string} email
 * @property {SuppressionReason} reason
 * @property {string} [bounceType]
 * @property {string} [notes]
 *
 * @typedef {Object} SuppressEmailContext
 * @property {SuppressEmailArgs} arguments
 * @property {Record<string, unknown>} [result]
 */

/**
 * @param {SuppressEmailContext} ctx
 */
export function request(ctx) {
  const { email, reason, bounceType, notes } = ctx.arguments;

  // Fail fast on empty email — concurrent callers (the bounce Lambda batched
  // over SNS) should never send a blank, and a silent no-op would let
  // bounces accumulate uncounted.
  if (!email || email.trim() === '') {
    throw new Error('suppressEmail: email argument is required');
  }

  const now = new Date().toISOString();
  /** @type {Record<string, string>} */
  const expressionNames = {
    '#reason': 'reason',
    '#firstSeenAt': 'firstSeenAt',
    '#lastSeenAt': 'lastSeenAt',
    '#occurrences': 'occurrences',
  };
  /** @type {Record<string, { S?: string; N?: string }>} */
  const expressionValues = {
    ':reason': { S: reason },
    ':now': { S: now },
    ':one': { N: '1' },
  };

  const setClauses = [
    '#reason = :reason',
    '#firstSeenAt = if_not_exists(#firstSeenAt, :now)',
    '#lastSeenAt = :now',
  ];

  if (bounceType !== undefined) {
    expressionNames['#bounceType'] = 'bounceType';
    expressionValues[':bounceType'] = { S: bounceType };
    setClauses.push('#bounceType = :bounceType');
  }
  if (notes !== undefined) {
    expressionNames['#notes'] = 'notes';
    expressionValues[':notes'] = { S: notes };
    setClauses.push('#notes = :notes');
  }

  return {
    operation: 'UpdateItem',
    key: { email: { S: email } },
    update: {
      expression: `SET ${setClauses.join(', ')} ADD #occurrences :one`,
      expressionNames,
      expressionValues,
    },
  };
}

/**
 * @param {SuppressEmailContext} ctx
 */
export function response(ctx) {
  return ctx.result;
}
