import { a } from '@aws-amplify/backend';

/**
 * RevisionVote — up / down votes on TranscriptRevision proposals (#35).
 *
 * One vote per `(revisionId, voterId)`. `castRevisionVote` (below) is
 * the sole write path: a two-step JS pipeline that GetItems the
 * voter's live `Reputation.computedWeight` and snapshots it into
 * `weightAtVoteTime` (mirrors the FieldVote pattern from #266 / #33).
 *
 * Deferred (still tracked under #35):
 *   - Aggregate-only public-read custom resolver that returns
 *     weighted up/down counts to guest/auth callers while preserving
 *     raw row access for mods + admins.
 *   - Score-recompute trigger on RevisionVote create / update /
 *     delete (DDB Stream Lambda → updates parent
 *     `TranscriptRevision.voteScore`). Phase 3 work.
 */
export const RevisionVote = a
  .model({
    revisionId: a.id().required(),
    revision: a.belongsTo('TranscriptRevision', 'revisionId'),
    // Cognito sub of the voter — `User.id = cognitoSub` (#259).
    voterId: a.id().required(),
    voter: a.belongsTo('User', 'voterId'),
    // Ref the named `RevisionVoteValue` enum exported below (#310) —
    // an inline `a.enum([...])` here used to ship alongside the named
    // enum and AppSync rejected the resulting schema for declaring
    // `enum RevisionVoteValue` twice.
    value: a.ref('RevisionVoteValue').required(),
    weightAtVoteTime: a.float().required(),
  })
  .identifier(['revisionId', 'voterId'])
  .secondaryIndexes((i) => [
    // Required for the legacy-claim FK fan-out (#273) — Query by voterId
    // alone. `voterId` is the sort half of the compound identifier, so
    // there is no base-table read path keyed on `voterId` only. Fan-out
    // is also special-cased: voterId is part of the compound PK, so the
    // rewrite is a per-row delete + put, not a simple Update.
    i('voterId'),
  ])
  .authorization((allow) => [
    // No `create` here — `castRevisionVote` is the sole write path
    // so the resolver can derive `voterId` from `ctx.identity.sub`
    // (#259) + snapshot live weight from Reputation (#33 pattern).
    // Leaving the auto-generated `createRevisionVote` mutation live
    // would accept an attacker-supplied `voterId` argument and
    // defeat the snapshot invariant.
    allow.authenticated().to(['read']),
    // No owner write surface (#312). `castRevisionVote` is the sole
    // authoritative write path so the resolver can enforce
    // `voterId = ctx.identity.sub` (#259) AND the `weightAtVoteTime`
    // if_not_exists snapshot. Re-opening owner-side `update` /
    // `delete` here would auto-generate `updateRevisionVote` /
    // `deleteRevisionVote` mutations that bypass both invariants.
    // Vote retraction is intentionally not supported at v1; when it
    // is, add a dedicated `retractRevisionVote` resolver with its
    // own audit + invariant checks rather than re-enabling owner-
    // write here.
    allow.groups(['moderator', 'admin']).to(['read']),
  ]);

/**
 * Shared enum so the model column + the `castRevisionVote` mutation
 * argument stay in lockstep. AppSync requires enum args to be
 * addressable types; we register this on the schema and `a.ref` it
 * from the mutation + the model.
 */
export const RevisionVoteValue = a.enum(['UP', 'DOWN']);

/**
 * `castRevisionVote` — upsert a RevisionVote row (#35).
 *
 * Two-step JS pipeline:
 *   1. `lookup-voter-reputation.js` — GetItem on Reputation by the
 *      voter's Cognito sub. Reused from the FieldVote pipeline (#33).
 *   2. `cast-revision-vote.js` — UpdateItem on RevisionVote keyed on
 *      the compound (revisionId, voterId) PK. Uses
 *      `ctx.prev.result.computedWeight` for the weight snapshot
 *      (falls back to 1 when missing).
 *
 * `voterId` is taken from `ctx.identity.sub`, never from arguments —
 * an authenticated user cannot vote as another user.
 */
export const castRevisionVote = a
  .mutation()
  .arguments({
    revisionId: a.id().required(),
    value: a.ref('RevisionVoteValue').required(),
  })
  .returns(a.ref('RevisionVote'))
  .authorization((allow) => allow.authenticated())
  .handler([
    a.handler.custom({
      dataSource: a.ref('Reputation'),
      entry: './resolvers/lookup-voter-reputation.js',
    }),
    a.handler.custom({
      dataSource: a.ref('RevisionVote'),
      entry: './resolvers/cast-revision-vote.js',
    }),
  ]);
