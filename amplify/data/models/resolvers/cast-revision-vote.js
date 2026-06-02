/**
 * AppSync JS pipeline-step resolver for the `castRevisionVote`
 * custom mutation (#35).
 *
 * Step 2 of a two-step pipeline. Step 1 (`lookup-voter-reputation.js`)
 * GetItems the voter's Reputation row; this step does the upsert on
 * RevisionVote using `ctx.prev.result?.computedWeight` for the
 * `weightAtVoteTime` snapshot (falls back to 1 when the row is
 * missing — pre-#36 lazy-create users).
 *
 * RevisionVote uses a compound identifier `(revisionId, voterId)`
 * so the natural one-vote-per-user-per-revision constraint is at
 * the PK layer. No synthesised key like FieldVote needs (#266) — the
 * compound is composable enough on its own. The resolver still owns
 * `voterId` derivation from `ctx.identity.sub`; trusting a
 * client-supplied voterId would let an authenticated user vote as
 * another user.
 *
 * Idempotency:
 *   - `voterId`, `weightAtVoteTime` pinned with `if_not_exists` so
 *     re-casting the same vote never re-stamps the weight snapshot
 *     or rewrites the voter identity.
 *   - `value` overwritten on every call so the row reflects the
 *     voter's current pick (UP / DOWN).
 *
 * Shipped as-is to AppSync (APPSYNC_JS runtime 1.0.0). No
 * TypeScript syntax; types via JSDoc + `./cast-revision-vote.d.ts`.
 * Behaviour pinned by `./cast-revision-vote.test.ts`.
 */

import { util } from '@aws-appsync/utils';

/**
 * @typedef {'UP' | 'DOWN'} RevisionVoteValue
 *
 * @typedef {Object} CastRevisionVoteArgs
 * @property {string} revisionId
 * @property {RevisionVoteValue} value
 *
 * @typedef {Object} CastRevisionVoteIdentity
 * @property {string} sub
 *
 * @typedef {Object} CastRevisionVoteContext
 * @property {CastRevisionVoteArgs} arguments
 * @property {CastRevisionVoteIdentity | undefined} identity
 * @property {Record<string, unknown>} [result]
 * @property {{ result?: { computedWeight?: number } | null } | undefined} [prev]
 */

/**
 * @param {CastRevisionVoteContext} ctx
 */
export function request(ctx) {
  const { revisionId, value } = ctx.arguments;

  if (!revisionId || revisionId.trim() === '') {
    util.error('castRevisionVote: revisionId argument is required');
  }
  if (!value || `${value}`.trim() === '') {
    util.error('castRevisionVote: value argument is required');
  }
  if (value !== 'UP' && value !== 'DOWN') {
    util.error(`castRevisionVote: value must be UP or DOWN; got ${value}`);
  }

  if (!ctx.identity || !ctx.identity.sub) {
    util.error('castRevisionVote: caller identity (Cognito sub) is required');
  }
  const voterId = ctx.identity.sub;

  // Live Reputation snapshot read by the upstream pipeline step.
  // Missing row falls back to 1 (base weight).
  const liveWeight =
    typeof ctx.prev?.result?.computedWeight === 'number' ? ctx.prev.result.computedWeight : 1;

  /** @type {Record<string, string>} */
  const expressionNames = {
    '#value': 'value',
    '#weightAtVoteTime': 'weightAtVoteTime',
  };
  /** @type {Record<string, { S?: string; N?: string }>} */
  const expressionValues = {
    ':value': { S: value },
    // Template literal instead of `String(liveWeight)` — APPSYNC_JS
    // rejects calls to the `String` global constructor (#323).
    ':weightAtVoteTime': { N: `${liveWeight}` },
  };

  // `voterId` (the RANGE half of the composite PK `(revisionId, voterId)`)
  // is deliberately NOT in this SET: DynamoDB rejects an UpdateExpression
  // that touches a key attribute. Both key halves are written automatically
  // from the `key` parameter on upsert. Including voterId here made every
  // castRevisionVote fail (#663).
  const setClauses = [
    '#weightAtVoteTime = if_not_exists(#weightAtVoteTime, :weightAtVoteTime)',
    '#value = :value',
  ];

  return {
    operation: 'UpdateItem',
    key: {
      revisionId: { S: revisionId },
      voterId: { S: voterId },
    },
    update: {
      expression: `SET ${setClauses.join(', ')}`,
      expressionNames,
      expressionValues,
    },
  };
}

/**
 * @param {CastRevisionVoteContext} ctx
 */
export function response(ctx) {
  // Surface a data-source error instead of swallowing it (#663).
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
