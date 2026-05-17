/**
 * AppSync JS pipeline-step resolver for `castFieldVote` (#33
 * weight-snapshot deferral). Runs ahead of `cast-field-vote.js` so
 * the upsert can stamp `weightAtVoteTime` from the voter's live
 * `Reputation.computedWeight` instead of the hardcoded 1 the
 * single-handler version used.
 *
 * Pipeline shape:
 *   1. THIS resolver — GetItem on Reputation(userId = ctx.identity.sub).
 *      Returns the row (or `null` when the voter has no Reputation
 *      row yet — pre-#36 lazy-create users + future opt-out cases).
 *   2. `cast-field-vote.js` — UpdateItem on FieldVote; reads
 *      `ctx.prev.result?.computedWeight ?? 1` for the snapshot.
 *
 * Why a GetItem in the pipeline rather than a denormalised join:
 *   - DynamoDB has no native FK join. AppSync JS pipeline resolvers
 *     are the lightweight equivalent — one extra Get per cast.
 *   - The Reputation row is identifier-keyed on `userId`, so the
 *     GetItem is O(1) and adds <5 ms to the hot path.
 *
 * The PII-blanked-user / banned-user / role-bonus questions all live
 * on Reputation's recompute hook (phase 3); this resolver just
 * reflects whatever the current row says.
 *
 * Shipped as-is to AppSync (APPSYNC_JS runtime 1.0.0). No TypeScript
 * syntax; types via JSDoc + `./lookup-voter-reputation.d.ts`. Behaviour
 * pinned by `./lookup-voter-reputation.test.ts`.
 */

/**
 * @typedef {Object} VoterIdentity
 * @property {string} [sub]
 *
 * @typedef {Object} LookupVoterReputationContext
 * @property {VoterIdentity | undefined | null} identity
 * @property {{ computedWeight?: number } | null} [result]
 */

/**
 * @param {LookupVoterReputationContext} ctx
 */
export function request(ctx) {
  // The voter is whoever the JWT says they are. The downstream
  // resolver also asserts this; failing here keeps the pipeline
  // short on bad input.
  if (!ctx.identity || !ctx.identity.sub) {
    throw new Error('lookup-voter-reputation: caller identity (Cognito sub) is required');
  }
  const voterId = ctx.identity.sub;
  return {
    operation: 'GetItem',
    key: { userId: { S: voterId } },
    // Project only `computedWeight` — the downstream resolver only
    // needs that one column, and the projection keeps the row scan
    // cheap.
    projection: {
      expression: '#cw',
      expressionNames: { '#cw': 'computedWeight' },
    },
  };
}

/**
 * @param {LookupVoterReputationContext} ctx
 */
export function response(ctx) {
  // Pass the row through (or null if the voter has no Reputation
  // row yet). The downstream resolver reads
  // `ctx.prev.result?.computedWeight` with a `?? 1` fallback so a
  // missing row gracefully snapshots at the base weight.
  return ctx.result ?? null;
}
