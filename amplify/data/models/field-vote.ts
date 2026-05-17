import { a } from '@aws-amplify/backend';

/**
 * FieldVote — per-field votes on parsed Message classification (#33).
 *
 * One vote per `(messageId, field, voterId)`. The natural composite PK
 * cannot be expressed as `.identifier(['messageId', 'field', 'voterId'])`
 * because Amplify Gen 2 rejects nullable enum columns in a composite
 * identifier (`EnumType` exposes no `.required()` modifier) — see #266
 * for the surfaced error. The model therefore stores a synthesised
 * composite PK column `fieldKey` formatted `<messageId>#<field>#<voterId>`
 * and uses that as the identifier; the `field` enum stays as a regular
 * typed column so semantic queries + GraphQL type safety still work.
 *
 * `fieldKey` is **never composed client-side** — the `castFieldVote`
 * mutation owns synthesis so the format is enforced server-side and
 * the voterId comes from `ctx.identity.sub` (sub-as-id, #259) rather
 * than an attacker-controlled argument. The `i('messageId')` GSI keeps
 * the "all votes for a given message + field" aggregate-count read
 * cheap (the public count surface is the consumer that needs it).
 *
 * `weightAtVoteTime` snapshots the voter's Reputation.computedWeight at
 * vote creation so the tally stays stable when a voter's reputation
 * changes later. Aggregate counts are public
 * (`{ "type": { "SKYKING": 12.5, ... } }` weighted sums); individual
 * vote rows are restricted to mod / admin.
 *
 * `weightAtVoteTime` is stamped by a two-step pipeline resolver
 * (#33): step 1 GetItems the voter's Reputation row, step 2 runs
 * the FieldVote UpdateItem using `ctx.prev.result.computedWeight`
 * (or 1 when the row is missing).
 *
 * Deferred (still tracked under #33):
 *   - Custom resolver that returns aggregate counts to guest / authed
 *     while preserving raw access for mods + admins.
 *
 * Other deferred items:
 *   - Orphan-vote janitor — landed at #270 / PR #281.
 */
export const FieldVote = a
  .model({
    /**
     * Synthesised composite PK in the form `<messageId>#<field>#<voterId>`.
     * Computed at write time by the `castFieldVote` mutation resolver
     * (#266). Clients must not compose this directly.
     */
    fieldKey: a.string().required(),
    messageId: a.id().required(),
    message: a.belongsTo('Message', 'messageId'),
    field: a.enum(['SENDER', 'RECEIVER', 'BODY', 'TYPE']),
    value: a.string().required(),
    // Cognito sub of the voter — `User.id = cognitoSub` (#259).
    voterId: a.id().required(),
    voter: a.belongsTo('User', 'voterId'),
    weightAtVoteTime: a.float().required(),
    firstCastAt: a.datetime(),
    lastCastAt: a.datetime(),
  })
  .identifier(['fieldKey'])
  // GSI for the natural lookup pattern: "all votes on message M's field F".
  // The public aggregate counts need this — sorting by voterId keeps the
  // per-voter dedupe scan cheap when we render the aggregate.
  .secondaryIndexes((i) => [
    i('messageId').sortKeys(['field', 'voterId']),
    // Required for the legacy-claim FK fan-out (#273) — Query by voterId
    // alone (the existing GSI puts voterId as a sort key, which can't be
    // queried without `messageId`). Fan-out is also special-cased: voterId
    // is part of the synthesised `fieldKey` PK, so the rewrite is a
    // per-row delete + put, not a simple Update.
    i('voterId'),
  ])
  .authorization((allow) => [
    // No `create` here — `castFieldVote` is the sole write path so the
    // resolver can derive `voterId` from `ctx.identity.sub` (#259).
    // Leaving the auto-generated `createFieldVote` mutation live would
    // accept an attacker-supplied `voterId` argument and defeat that
    // invariant.
    allow.authenticated().to(['read']),
    // Voter = the Cognito sub stored in `voterId` (#259).
    allow.ownerDefinedIn('voterId').identityClaim('sub').to(['update', 'delete']),
    allow.groups(['moderator', 'admin']).to(['read']),
  ]);

/**
 * Shared enum so the model column and the `castFieldVote` mutation
 * argument stay in lockstep. AppSync requires enum args to be
 * addressable types; we register this on the schema and `a.ref` it from
 * `castFieldVote` + the model.
 */
export const FieldVoteField = a.enum(['SENDER', 'RECEIVER', 'BODY', 'TYPE']);

/**
 * `castFieldVote` — upsert a FieldVote row (#266 + #33).
 *
 * The mutation synthesises the composite `fieldKey` server-side so the
 * client never composes a PK by hand and an authenticated user cannot
 * cast a vote as another user (voterId is taken from `ctx.identity.sub`,
 * not from the arguments). Re-casting the same vote refreshes the
 * `value` + `lastCastAt` columns without restamping the natural-key
 * components or the `weightAtVoteTime` snapshot.
 *
 * Two-step JS pipeline (#33):
 *   1. `lookup-voter-reputation.js` — GetItem on Reputation by the
 *      voter's Cognito sub. Returns the row (or null when missing).
 *   2. `cast-field-vote.js` — UpdateItem on FieldVote; uses
 *      `ctx.prev.result.computedWeight` for the snapshot
 *      (falls back to 1 when the row is missing).
 *
 * Resolver sources: ./resolvers/lookup-voter-reputation.js +
 * ./resolvers/cast-field-vote.js (both JS — shipped as-is to the
 * APPSYNC_JS runtime).
 */
export const castFieldVote = a
  .mutation()
  .arguments({
    messageId: a.id().required(),
    field: a.ref('FieldVoteField').required(),
    value: a.string().required(),
  })
  .returns(a.ref('FieldVote'))
  .authorization((allow) => allow.authenticated())
  .handler([
    a.handler.custom({
      dataSource: a.ref('Reputation'),
      entry: './resolvers/lookup-voter-reputation.js',
    }),
    a.handler.custom({
      dataSource: a.ref('FieldVote'),
      entry: './resolvers/cast-field-vote.js',
    }),
  ]);
