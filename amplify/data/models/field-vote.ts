import { a } from '@aws-amplify/backend';

/**
 * FieldVote — per-field votes on parsed Message classification (#33).
 *
 * One vote per `(messageId, field, voterId)`; composite identifier enforces
 * uniqueness — change-vote is an update on the same row. `weightAtVoteTime`
 * snapshots the voter's Reputation.computedWeight at vote creation so the
 * tally is stable even when a voter's reputation changes later.
 *
 * Aggregate counts are public (`{ "type": { "SKYKING": 12.5, ... } }` weighted
 * sums); individual vote rows are restricted to mod / admin. The
 * aggregate-only public visibility is a custom resolver, deferred — for now
 * the model authz is restrictive enough that the leak risk is contained to
 * authenticated users seeing each other's votes (acceptable v1).
 *
 * Deferred:
 *   - Custom resolver that returns aggregate counts to guest / authenticated
 *     while preserving raw access for mods + admins.
 *   - Hook that pulls `Reputation.computedWeight` at create + freezes it.
 */
export const FieldVote = a
  .model({
    messageId: a.id().required(),
    message: a.belongsTo('Message', 'messageId'),
    field: a.enum(['SENDER', 'RECEIVER', 'BODY', 'TYPE']),
    value: a.string().required(),
    // Cognito sub of the voter — `User.id = cognitoSub` (#259).
    voterId: a.id().required(),
    voter: a.belongsTo('User', 'voterId'),
    weightAtVoteTime: a.float().required(),
  })
  // Composite identifier — the natural PK order already provides
  // `(messageId, field, voterId)` traversal, so the redundant GSI on
  // `(messageId, field)` is omitted.
  .identifier(['messageId', 'field', 'voterId'])
  .authorization((allow) => [
    allow.authenticated().to(['read', 'create']),
    // Voter = the Cognito sub stored in `voterId` (#259).
    allow
      .ownerDefinedIn('voterId')
      .identityClaim('sub')
      .to(['update', 'delete']),
    allow.groups(['moderator', 'admin']).to(['read']),
  ]);
