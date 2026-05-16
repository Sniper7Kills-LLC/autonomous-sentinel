/**
 * AppSync JS resolver for the `isSuppressed` custom query (issue #249).
 *
 * Called by the email-send Lambda before every outbound fan-out. Returns
 * true if a row exists in EmailSuppression for `email`, false otherwise.
 *
 * Deliberately a single GetItem with no consistency knob — the bounce
 * Lambda writes inline on every SES SNS event, so an eventually-consistent
 * read is fine. A miss followed by a send-to-bouncing-address one second
 * later only adds one more bounce to the count, which is the worst case
 * we'd accept; tightening that costs RCUs for vanishingly small gain.
 *
 * This file is shipped as-is to AppSync (APPSYNC_JS runtime 1.0.0). Tests
 * in `./is-suppressed.test.ts`.
 */

/**
 * @typedef {Object} IsSuppressedArgs
 * @property {string} email
 *
 * @typedef {Object} IsSuppressedContext
 * @property {IsSuppressedArgs} arguments
 * @property {unknown} [result]
 */

/**
 * @param {IsSuppressedContext} ctx
 */
export function request(ctx) {
  const { email } = ctx.arguments;
  if (!email || email.trim() === '') {
    throw new Error('isSuppressed: email argument is required');
  }
  return {
    operation: 'GetItem',
    key: { email: { S: email } },
  };
}

/**
 * @param {IsSuppressedContext} ctx
 */
export function response(ctx) {
  // ctx.result is the row (or null when no match). Cast to boolean so
  // the caller gets a simple yes/no.
  return ctx.result != null;
}
