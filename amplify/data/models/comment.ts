import { a } from '@aws-amplify/backend';
import { commentMutations } from '../../functions/commentMutations/resource';

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
 * Custom mutations land below:
 *   - `submitComment` — server-side depth clamp + flatten + authorId
 *     forced from `ctx.identity.sub`. Named with a distinct verb (not
 *     `createComment`) because Amplify Gen 2's transformer auto-emits
 *     `create<Model>` for every `@model`, and a custom mutation with
 *     the same field name would collide with the auto-emitted one at
 *     synth (#314).
 *   - `softDeleteComment` — author / mod / admin → sets deletedAt
 *     + rewrites body to `[removed]` + emits COMMENT_DELETE audit.
 *
 * Deferred:
 *   - Auto-flag hook from the hybrid wordlist + Comprehend pipeline
 *     (phase 9 #167).
 */
export const Comment = a
  .model({
    messageId: a.id().required(),
    message: a.belongsTo('Message', 'messageId'),
    parentCommentId: a.id(),
    parentComment: a.belongsTo('Comment', 'parentCommentId'),
    childComments: a.hasMany('Comment', 'parentCommentId'),
    // Server-computed by the depth-clamp custom mutation (deferred). Optional
    // at the schema level so the client never has to supply it; the mutation
    // sets `min(parent.depth + 1, 3)` at create time.
    depth: a.integer().default(0),
    body: a.string().required(),
    // Cognito sub of the author — `User.id = cognitoSub` (#259).
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
    // Required for the legacy-claim FK fan-out (#273) — Query by authorId
    // to find every Comment a freshly-claimed user wrote.
    i('authorId'),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    // No `create` on the model — `submitComment` is the sole write
    // path so the server can enforce depth-clamp + flatten + the
    // authorId-from-ctx.identity.sub guard. Leaving the auto-
    // generated `createComment` mutation live would accept a
    // client-supplied authorId + depth and defeat both invariants
    // (and would also have collided with a custom `createComment`
    // at synth — see #314 / the verb-rename rationale at the top).
    allow.authenticated().to(['read']),
    // #430 Cognito-group sweep — only `member` here. Admin + moderator
    // pick up `read` via the merged elevated rule below (Amplify
    // @auth rejects the same group in two `allow.groups(...)` rules
    // per model, so the elevated rule absorbs `read` alongside the
    // existing `update` + `delete`).
    allow.groups(['member']).to(['read']),
    // Owner = the Cognito sub stored in `authorId` (#259). Kept for
    // direct edit / delete paths if we ever expose them; the soft-
    // delete custom mutation is the recommended route since it
    // rewrites `body` to `[removed]` + emits the audit.
    allow.ownerDefinedIn('authorId').identityClaim('sub').to(['update', 'delete']),
    allow.groups(['moderator', 'admin']).to(['read', 'update', 'delete']),
  ]);

/**
 * `submitComment` — depth-clamped + flatten Comment create (#32).
 *
 * Named with the `submit` verb (not `create`) to avoid colliding
 * with the auto-generated `createComment` mutation that the Amplify
 * Gen 2 transformer emits for every `@model` row regardless of
 * authz grants (#314 — dropping `create` from the model authz only
 * gates access, it does NOT prevent the auto-emitted field from
 * existing on `type Mutation`).
 *
 * Server-side guarantees the client can't forge:
 *   - `authorId = ctx.identity.sub`.
 *   - `depth = min(parent.depth + 1, 3)`.
 *   - `parentCommentId` must belong to the same `messageId`.
 *
 * Returns the created Comment row.
 */
export const submitComment = a
  .mutation()
  .arguments({
    messageId: a.id().required(),
    body: a.string().required(),
    parentCommentId: a.id(),
  })
  .returns(a.ref('Comment'))
  // #430: authenticated + group-paired.
  .authorization((allow) => [allow.authenticated(), allow.groups(['admin', 'moderator', 'member'])])
  .handler(a.handler.function(commentMutations));

/**
 * `softDeleteComment` — author or moderator/admin soft-delete (#32).
 *
 * Sets `deletedAt = now`, rewrites `body` to `[removed]`, emits a
 * `COMMENT_DELETE` AuditLog entry via the #258 helper. Idempotent on
 * already-deleted rows.
 */
export const softDeleteComment = a
  .mutation()
  .arguments({
    commentId: a.id().required(),
    reason: a.string(),
  })
  .returns(a.ref('Comment'))
  // #430: authenticated + group-paired.
  .authorization((allow) => [allow.authenticated(), allow.groups(['admin', 'moderator', 'member'])])
  .handler(a.handler.function(commentMutations));
