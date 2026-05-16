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
    voterId: a.id().required(),
    voter: a.belongsTo('User', 'voterId'),
    value: a.enum(['UP', 'DOWN']),
    weightAtVoteTime: a.float().required(),
  })
  .identifier(['revisionId', 'voterId'])
  .authorization((allow) => [
    allow.authenticated().to(['read', 'create']),
    allow.owner().to(['update', 'delete']),
    allow.groups(['moderator', 'admin']).to(['read']),
  ]);
