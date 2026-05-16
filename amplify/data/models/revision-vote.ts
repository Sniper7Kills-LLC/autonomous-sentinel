import { a } from '@aws-amplify/backend';

/**
 * RevisionVote — up / down votes on TranscriptRevision proposals (#35).
 *
 * One vote per `(revisionId, voterId)`. Same reputation-weighting +
 * aggregate-only public visibility pattern as FieldVote. On create / update /
 * delete, the parent TranscriptRevision's `voteScore` is recomputed —
 * deferred to a custom resolver.
 */
export const RevisionVote = a
  .model({
    revisionId: a.id().required(),
    revision: a.belongsTo('TranscriptRevision', 'revisionId'),
    // Cognito sub of the voter — `User.id = cognitoSub` (#259).
    voterId: a.id().required(),
    voter: a.belongsTo('User', 'voterId'),
    value: a.enum(['UP', 'DOWN']),
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
    allow.authenticated().to(['read', 'create']),
    // Voter = the Cognito sub stored in `voterId` (#259).
    allow.ownerDefinedIn('voterId').identityClaim('sub').to(['update', 'delete']),
    allow.groups(['moderator', 'admin']).to(['read']),
  ]);
