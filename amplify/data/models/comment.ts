import { a } from '@aws-amplify/backend';

/**
 * Comment — community discussion on Messages (#32).
 *
 * Nested up to depth 3 (per CLAUDE.md); deeper replies flatten — the create
 * resolver clamps `depth = min(parent.depth + 1, 3)` and rewrites
 * `parentCommentId` to the deepest legal ancestor.
 *
 * Soft-delete only (`deletedAt` sentinel); body is replaced with `[removed]`
 * by the soft-delete custom mutation.
 *
 * Deferred:
 *   - Depth-clamp custom mutation (server-side enforcement).
 *   - Soft-delete custom mutation (writes AuditLog entry; needs #38).
 *   - Auto-flag hook from the hybrid wordlist + Comprehend pipeline.
 */
export const Comment = a
  .model({
    messageId: a.id().required(),
    message: a.belongsTo('Message', 'messageId'),
    parentCommentId: a.id(),
    parentComment: a.belongsTo('Comment', 'parentCommentId'),
    childComments: a.hasMany('Comment', 'parentCommentId'),
    depth: a.integer().required().default(0),
    body: a.string().required(),
    authorId: a.id().required(),
    author: a.belongsTo('User', 'authorId'),
    flagged: a.boolean().default(false),
    deletedAt: a.datetime(),
  })
  .secondaryIndexes((i) => [
    // Thread fetch — sort client-side by `createdAt` (Amplify Gen 2 does not
    // allow the implicit `createdAt` as an index sort key).
    i('messageId'),
    i('parentCommentId'),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read', 'create']),
    allow.owner().to(['update', 'delete']),
    allow.groups(['moderator', 'admin']).to(['update', 'delete']),
  ]);
