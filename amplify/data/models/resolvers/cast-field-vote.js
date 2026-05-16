/**
 * AppSync JS resolver for the `castFieldVote` custom mutation (issue #266).
 *
 * Upserts a row into the FieldVote table keyed on a synthesised composite
 * primary key formatted `<messageId>#<field>#<voterId>`. The synthesis is
 * the whole point of #266: Amplify Gen 2 rejects nullable enum columns in
 * `.identifier(...)`, so the natural `(messageId, field, voterId)` PK is
 * collapsed into a single required string column (`fieldKey`) and computed
 * server-side here.
 *
 * Why the resolver and not the client:
 *   - Composing the key on the client is brittle — every caller has to
 *     remember the format and ordering, and any drift silently breaks the
 *     PK uniqueness contract.
 *   - The voterId is the Cognito sub (sub-as-id, #259); only the resolver
 *     can read it from `ctx.identity.sub`. Trusting a client-supplied
 *     voterId would let an authenticated user vote as someone else.
 *
 * Idempotency:
 *   - `fieldKey`, `messageId`, `field`, `voterId`, `weightAtVoteTime`, and
 *     `firstCastAt` are pinned with `if_not_exists` so re-casting the same
 *     vote never re-stamps the key components or the weight snapshot.
 *   - `value` and `lastCastAt` are overwritten on every call so the
 *     row reflects the voter's current pick.
 *
 * `weightAtVoteTime` defaults to 1 here. Pulling the live
 * Reputation.computedWeight at vote-cast time is a follow-up (tracked on
 * #266 as deferred behaviour — see field-vote.ts docstring).
 *
 * This file is shipped as-is to AppSync (APPSYNC_JS runtime 1.0.0). The
 * runtime does not transpile — keep this JS, no TypeScript syntax. Types
 * are documented via JSDoc and pinned by `./cast-field-vote.test.ts`.
 */

/**
 * @typedef {'SENDER' | 'RECEIVER' | 'BODY' | 'TYPE'} FieldVoteField
 *
 * @typedef {Object} CastFieldVoteArgs
 * @property {string} messageId
 * @property {FieldVoteField} field
 * @property {string} value
 *
 * @typedef {Object} CastFieldVoteIdentity
 * @property {string} sub
 *
 * @typedef {Object} CastFieldVoteContext
 * @property {CastFieldVoteArgs} arguments
 * @property {CastFieldVoteIdentity | undefined} identity
 * @property {Record<string, unknown>} [result]
 */

/**
 * @param {CastFieldVoteContext} ctx
 */
export function request(ctx) {
  const { messageId, field, value } = ctx.arguments;

  // Fail fast on missing / blank arguments — a silent UpdateItem with an
  // empty PK component would leave a malformed row in the table that the
  // public aggregate count would happily roll into the wrong bucket.
  if (!messageId || messageId.trim() === '') {
    throw new Error('castFieldVote: messageId argument is required');
  }
  if (!field || String(field).trim() === '') {
    throw new Error('castFieldVote: field argument is required');
  }
  if (!value || value.trim() === '') {
    throw new Error('castFieldVote: value argument is required');
  }

  // The voter is whoever the JWT says they are — never the client's claim.
  if (!ctx.identity || !ctx.identity.sub) {
    throw new Error('castFieldVote: caller identity (Cognito sub) is required');
  }
  const voterId = ctx.identity.sub;

  const fieldKey = `${messageId}#${field}#${voterId}`;
  const now = new Date().toISOString();

  /** @type {Record<string, string>} */
  const expressionNames = {
    '#fieldKey': 'fieldKey',
    '#messageId': 'messageId',
    '#field': 'field',
    '#voterId': 'voterId',
    '#value': 'value',
    '#weightAtVoteTime': 'weightAtVoteTime',
    '#firstCastAt': 'firstCastAt',
    '#lastCastAt': 'lastCastAt',
  };
  /** @type {Record<string, { S?: string; N?: string }>} */
  const expressionValues = {
    ':fieldKey': { S: fieldKey },
    ':messageId': { S: messageId },
    ':field': { S: field },
    ':voterId': { S: voterId },
    ':value': { S: value },
    ':weightAtVoteTime': { N: '1' },
    ':now': { S: now },
  };

  // Natural key + weight snapshot pinned with `if_not_exists` so re-casts
  // never restamp them; `value` + `lastCastAt` are mutable on every call.
  const setClauses = [
    '#fieldKey = if_not_exists(#fieldKey, :fieldKey)',
    '#messageId = if_not_exists(#messageId, :messageId)',
    '#field = if_not_exists(#field, :field)',
    '#voterId = if_not_exists(#voterId, :voterId)',
    '#weightAtVoteTime = if_not_exists(#weightAtVoteTime, :weightAtVoteTime)',
    '#firstCastAt = if_not_exists(#firstCastAt, :now)',
    '#value = :value',
    '#lastCastAt = :now',
  ];

  return {
    operation: 'UpdateItem',
    key: { fieldKey: { S: fieldKey } },
    update: {
      expression: `SET ${setClauses.join(', ')}`,
      expressionNames,
      expressionValues,
    },
  };
}

/**
 * @param {CastFieldVoteContext} ctx
 */
export function response(ctx) {
  return ctx.result;
}
