import { a } from '@aws-amplify/backend';
import { userMutations } from '../../functions/userMutations/resource';
import { getUserPublicLambda } from '../../functions/getUserPublicLambda/resource';

/**
 * User — DynamoDB shadow of the Cognito identity (issue #248).
 *
 * Anchor for almost every other entity, survivor of self-deletion (PII
 * blanked, row retained, submissions intact). The post-confirmation Lambda
 * (#15) creates the row on first signup; the legacy claim flow (#16) links
 * v3 email matches into pre-seeded rows.
 *
 * Identifier strategy (issue #259, Option A): `User.id` *is* the Cognito sub.
 * `.identifier(['cognitoSub'])` makes the sub the primary key, which lets
 * every `allow.owner()` rule on every FK-owning model compare the JWT `sub`
 * directly to the FK column without an indirection through a separate UUID.
 *
 * Pre-seeded migration rows have no Cognito identity yet — they are stored
 * with `cognitoSub = "legacy:<legacyUserId>"`. The claim flow (#16) rewrites
 * the row at claim time, swapping the placeholder PK for the real sub and
 * fanning the update across every FK row that previously pointed at the
 * placeholder.
 *
 * Custom operations bound to this model (defined below):
 *   - `selfDelete` — caller blanks PII on their own row, sets piiBlanked,
 *     emits `USER_PII_BLANK` AuditLog. Lambda-resolved via #258 helper.
 *   - `banUser`    — admin sets bannedAt/Reason/ById on a target row,
 *     emits `USER_BAN` AuditLog. Lambda-resolved via #258 helper.
 *   - `getUserPublic` — guest/auth-callable wrapper around GetItem that
 *     nulls email / preferredUsername / displayName when piiBlanked=true.
 *     Admin reads bypass the filter via the direct model resolver.
 */
export const User = a
  .model({
    // Identity link + primary key. Pre-seeded migration rows store
    // `legacy:<legacyUserId>` here until the claim flow rewrites them.
    cognitoSub: a.string().required(),

    // Contact + display. All three are blanked on self-deletion (PII flag
    // flipped) so queries still resolve but no PII leaks.
    email: a.string(),
    preferredUsername: a.string(),
    displayName: a.string(),

    // Role cache, mirrored from Cognito groups for quick filtering + display.
    // Real authorization runs off the `cognito:groups` claim.
    role: a.enum(['admin', 'moderator', 'member']),

    // Legacy v3 claim
    legacyUserId: a.integer(),
    legacyEmail: a.string(),
    claimStatus: a.enum(['PENDING_CLAIM', 'CLAIMED', 'FRESH_SIGNUP']),
    claimedAt: a.datetime(),

    // Self-deletion lifecycle. Row kept forever; PII fields wiped.
    piiBlanked: a.boolean().default(false),
    piiBlankedAt: a.datetime(),

    // Ban lifecycle. `bannedById` stores the Cognito sub of the admin who
    // issued the ban (#259 — `User.id = cognitoSub`).
    bannedAt: a.datetime(),
    bannedReason: a.string(),
    bannedById: a.id(),

    // Relationships
    recordings: a.hasMany('Recording', 'uploaderId'),
    sdrs: a.hasMany('Sdr', 'ownerId'),
    comments: a.hasMany('Comment', 'authorId'),
    fieldVotes: a.hasMany('FieldVote', 'voterId'),
    revisionVotes: a.hasMany('RevisionVote', 'voterId'),
    transcriptRevisions: a.hasMany('TranscriptRevision', 'proposedBy'),
    abuseReports: a.hasMany('AbuseReport', 'reporterId'),
    donations: a.hasMany('Donation', 'userId'),
    notificationPreference: a.hasOne('NotificationPreference', 'userId'),
    reputation: a.hasOne('Reputation', 'userId'),
  })
  .identifier(['cognitoSub'])
  .secondaryIndexes((i) => [
    // Email lookup for sign-in / support / claim conflict detection
    i('email'),
    // Legacy claim path: v3 user-by-email and v3 user-by-PK
    i('legacyEmail'),
    i('legacyUserId'),
    // Admin queries — "all banned users since X"
    i('bannedAt'),
    // Required for the legacy-claim FK fan-out (#273) — Query by bannedById
    // to find every User row banned by a freshly-claimed legacy admin. Rare
    // (only triggers when the issuing admin was also a legacy user) but
    // required to keep the audit chain attributable.
    i('bannedById'),
    // Required for the legacy-claim replay sweeper (#274) — Query for
    // `claimStatus = CLAIMED` rows so the daily cron can pick up users
    // whose User-row claim completed but whose FK fan-out (#273) was
    // interrupted. Sparse — only `CLAIMED` rows index here.
    i('claimStatus'),
  ])
  .authorization((allow) => [
    // Direct model reads are restricted to admin + moderator so PII-
    // bearing columns (email / legacyEmail / bannedReason / etc.)
    // never leak via the auto-generated `getUser` / `listUsers`
    // queries or via belongsTo fetches from anonymous callers. The
    // public read surface is `getUserPublic` (PII-filtered), defined
    // below.
    //
    // Side effect: belongsTo relations from public models (e.g.
    // `Recording.uploader`, `Comment.author`) resolve to null for
    // guest + member callers until those fetches are wrapped in
    // field-level resolvers or custom queries that pull from
    // `getUserPublic`. Phase-4 (admin/profile UI) owns that wrap.
    allow.groups(['moderator']).to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
    // No owner-update rule. Amplify Gen 2 model authz is row-level
    // (not field-level), so an `allow.ownerDefinedIn('cognitoSub')`
    // grant would let a banned user mutate `bannedAt` / `bannedReason`
    // / `bannedById` via the auto-generated `updateUser` mutation and
    // clear their own ban. All User row writes must route through the
    // custom mutations below (`selfDelete`, `banUser`, and the future
    // `updateProfile` field-restricted self-edit surface), so the
    // sensitive columns can be gated explicitly by the resolver.
    //
    // The post-confirmation Lambda creates fresh-signup rows; the
    // userMutations Lambda updates rows for selfDelete + banUser. Both
    // function-resource grants live at the schema level (see
    // `data/resource.ts`) because `allow.resource(...)` is a
    // schema-scope rule, not a per-model one.
  ]);

/**
 * `selfDelete` — caller blanks own PII (issue #248).
 *
 * Takes no arguments — the target row is keyed on `ctx.identity.sub`.
 * The handler:
 *   - Reads the existing User row.
 *   - If already piiBlanked, returns it untouched (idempotent).
 *   - Otherwise nulls `email` / `preferredUsername` / `displayName`,
 *     sets `piiBlanked=true` + `piiBlankedAt=now`, writes the row.
 *   - Emits a `USER_PII_BLANK` AuditLog entry via the #258 helper.
 *
 * Returns the post-mutation User row.
 */
export const selfDelete = a
  .mutation()
  .arguments({})
  .returns(a.ref('User'))
  .authorization((allow) => allow.authenticated())
  .handler(a.handler.function(userMutations));

/**
 * `banUser` — admin sets ban fields on a target row (issue #248).
 *
 * Arguments:
 *   - `targetCognitoSub` — the row to ban.
 *   - `reason`           — free-form admin note, stored on the row
 *     and on the audit entry.
 *
 * Sets `bannedAt = now`, `bannedReason = reason`, `bannedById =
 * caller.sub`. Emits a `USER_BAN` AuditLog entry. Returns the
 * post-mutation User row.
 *
 * `banUser` is purely a database state change — the actual sign-in
 * block lives in a phase-1 follow-up (banned-at-sign-in check, out of
 * scope here per the #248 body).
 */
export const banUser = a
  .mutation()
  .arguments({
    targetCognitoSub: a.string().required(),
    reason: a.string(),
  })
  .returns(a.ref('User'))
  .authorization((allow) => allow.group('admin'))
  .handler(a.handler.function(userMutations));

/**
 * `getUserPublic` — PII-filtered wrapper around GetItem (issue #248).
 *
 * Public profile pages hit this for guest + authenticated callers. The
 * resolver returns null for `email` / `preferredUsername` /
 * `displayName` whenever `piiBlanked=true`. Admin callers fall through
 * to the model-default `getUser` resolver and see the
 * blanked-but-retained values for audit purposes.
 *
 * The choice of a custom JS resolver (vs. extending the model's
 * built-in `get`) is deliberate: AppSync's default resolvers go
 * straight to DynamoDB and skip response shaping. The only way to
 * inject a deterministic per-caller filter is to own the resolver.
 */
export const getUserPublic = a
  .query()
  .arguments({ cognitoSub: a.string().required() })
  .returns(a.ref('User'))
  // Lambda-backed (#271). The original `a.handler.custom` JS resolver
  // couldn't carry `allow.guest()` under the `identityPool` default
  // auth mode — that limitation does not apply to
  // `a.handler.function`, so guest profile browse is restored.
  .authorization((allow) => [allow.guest(), allow.authenticated()])
  .handler(a.handler.function(getUserPublicLambda));
