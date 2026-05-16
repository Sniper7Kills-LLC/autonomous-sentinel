import { a } from '@aws-amplify/backend';

/**
 * User — DynamoDB shadow of the Cognito identity (issue #248).
 *
 * Anchor for almost every other entity, survivor of self-deletion (PII
 * blanked, row retained, submissions intact). The post-confirmation Lambda
 * (#15) creates the row on first signup; the legacy claim flow (#16) links
 * v3 email matches into pre-seeded rows.
 *
 * Deferred to follow-ups (need AuditLog #38 first):
 *   - Custom mutation `selfDelete` — blanks PII fields + writes AuditLog.
 *   - Custom mutation `banUser` — sets bannedAt/Reason/ById + writes AuditLog.
 *   - PII-filter resolver — when `piiBlanked=true`, return `null` for
 *     `email` / `displayName` / `preferredUsername` from non-admin reads.
 */
export const User = a
  .model({
    // Identity link. Null for pre-seeded migration rows awaiting claim.
    cognitoSub: a.string(),

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

    // Ban lifecycle
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
  .secondaryIndexes((i) => [
    // Cognito sub → User row (post-confirmation Lambda + token-context lookups)
    i('cognitoSub'),
    // Email lookup for sign-in / support / claim conflict detection
    i('email'),
    // Legacy claim path: v3 user-by-email and v3 user-by-PK
    i('legacyEmail'),
    i('legacyUserId'),
    // Admin queries — "all banned users since X"
    i('bannedAt'),
  ])
  .authorization((allow) => [
    // Public profile pages need read access; the deferred PII-filter resolver
    // replaces `email` / `displayName` / `preferredUsername` with null when
    // `piiBlanked=true`. Until that ships, treat the public surface as raw
    // — the migration tooling controls which rows exist.
    allow.guest().to(['read']),
    allow.authenticated().to(['read']),
    // Owner-of-row edits via Cognito sub identity claim. Self-delete + ban
    // fields will be locked down once the custom mutations land.
    allow.ownerDefinedIn('cognitoSub').identityClaim('sub').to(['update']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
