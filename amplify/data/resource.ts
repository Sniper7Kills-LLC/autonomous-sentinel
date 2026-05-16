import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

/**
 * Amplify Gen 2 data model for Autonomous Sentinel.
 *
 * Phase 2 adds the User model (#248) — the DynamoDB shadow of the Cognito
 * identity, anchor for almost every other entity, and survivor of
 * self-deletion (PII blanked, row retained, submissions intact). Other phase-2
 * models (Comment, Vote, AuditLog, etc.) land in their own issues and bolt
 * onto this file.
 *
 * Modeling notes (per CLAUDE.md):
 *   - One Message → many Recordings (multi-SDR capture).
 *   - Recordings dedup by content hash.
 *   - UTC timestamps in storage.
 *   - Soft deletes everywhere; AuditLog is the source of truth.
 *   - GraphQL is anon-readable for public browse (legacy site behavior).
 *
 * Deferred from #248 to follow-up issues (require AuditLog model #38):
 *   - Custom mutation `selfDelete` — blanks PII fields + writes AuditLog entry.
 *   - Custom mutation `banUser` — sets bannedAt/Reason/ById + writes AuditLog.
 *   - PII-filter custom resolver — when `piiBlanked=true`, return `null` for
 *     `email` / `displayName` / `preferredUsername` from non-admin reads.
 *   - hasMany declarations from User to Comment / FieldVote / RevisionVote /
 *     AbuseReport / Donation / TranscriptRevision / NotificationPreference /
 *     Reputation — added incrementally as those models land in #32 / #33 /
 *     #35 / #37 / #40 / #34 / #41 / #36.
 */
const schema = a.schema({
  User: a
    .model({
      // Identity link. Null for pre-seeded migration rows awaiting claim.
      // Populated by the post-confirmation Lambda (#15) at first signup, or by
      // the legacy-claim flow (#16) when a v3 email matches.
      cognitoSub: a.string(),

      // Contact + display. `email` is blanked on self-deletion (set to '') so
      // queries still resolve but no PII leaks. `displayName` is what the
      // public sees on profile pages and submission attribution.
      email: a.string(),
      preferredUsername: a.string(),
      displayName: a.string(),

      // Role cache, mirrored from Cognito groups. Real authorization runs off
      // the `cognito:groups` claim; this is here for quick filtering + display.
      // Refreshed by an admin-side reconcile job when group membership changes.
      role: a.enum(['admin', 'moderator', 'member']),

      // Legacy v3 claim
      legacyUserId: a.integer(),
      legacyEmail: a.string(),
      claimStatus: a.enum(['PENDING_CLAIM', 'CLAIMED', 'FRESH_SIGNUP']),
      claimedAt: a.datetime(),

      // Self-deletion lifecycle. Row is kept forever so audit + submissions
      // stay attributable; PII fields are wiped + flag flipped.
      piiBlanked: a.boolean().default(false),
      piiBlankedAt: a.datetime(),

      // Ban lifecycle
      bannedAt: a.datetime(),
      bannedReason: a.string(),
      bannedById: a.id(),

      // Relationships. Only the models that exist today are declared here;
      // Comment / Vote / AbuseReport / Donation / TranscriptRevision /
      // NotificationPreference / Reputation reverse-FKs land alongside their
      // own models in the rest of phase 2.
      recordings: a.hasMany('Recording', 'uploaderId'),
      sdrs: a.hasMany('Sdr', 'ownerId'),
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
      // Public profile pages need read access; a follow-up PII-filter resolver
      // (deferred) replaces `email` / `displayName` / `preferredUsername` with
      // null/`[deleted]` when `piiBlanked=true`. Until that ships, treat the
      // public surface as raw — the migration tooling controls which rows
      // exist and the field values are unsensitive at v1 (no real users yet).
      allow.guest().to(['read']),
      allow.authenticated().to(['read']),
      // Owner-of-row edits via Cognito sub identity claim. Self-delete +
      // ban-related fields will be locked down once the custom mutations land.
      allow.ownerDefinedIn('cognitoSub').identityClaim('sub').to(['update']),
      allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
    ]),

  Message: a
    .model({
      broadcastTs: a.datetime().required(),
      sender: a.string(),
      receiver: a.string(),
      type: a.enum([
        'BACKEND',
        'SKYKING',
        'ALLSTATIONS',
        'RADIOCHECK',
        'SKYMASTER',
        'SKYBIRD',
        'DISREGARDED',
        'OTHER',
      ]),
      body: a.string(),
      characterCount: a.integer(),
      confidence: a.float(),
      flaggedForReview: a.boolean().default(false),
      legacyUuid: a.string(),
      deletedAt: a.datetime(),
      recordings: a.hasMany('Recording', 'messageId'),
    })
    .authorization((allow) => [
      allow.guest().to(['read']),
      allow.authenticated().to(['read', 'create']),
      allow.groups(['moderator', 'admin']).to(['read', 'create', 'update', 'delete']),
    ]),

  Recording: a
    .model({
      messageId: a.id(),
      message: a.belongsTo('Message', 'messageId'),
      // Uploader FK to User (#248). Populated by the upload client (phase 6)
      // using the Cognito sub → User row lookup done at upload time.
      uploaderId: a.id(),
      uploader: a.belongsTo('User', 'uploaderId'),
      contentHash: a.string().required(),
      originalKey: a.string().required(),
      webCanonicalKey: a.string(),
      frequencyKhz: a.integer(),
      modulation: a.enum(['USB', 'LSB', 'AM', 'FM']),
      broadcastedAt: a.datetime(),
      automated: a.boolean().default(false),
      sdrId: a.id(),
      transcriptionStatus: a.enum([
        'QUEUED',
        'PREPROCESSING',
        'TRANSCRIBING',
        'PARSING',
        'PUBLISHED',
        'FAILED',
      ]),
      transcriptionFailed: a.boolean().default(false),
      deletedAt: a.datetime(),
    })
    .authorization((allow) => [
      allow.guest().to(['read']),
      allow.authenticated().to(['read', 'create']),
      allow.groups(['moderator', 'admin']).to(['read', 'create', 'update', 'delete']),
    ]),

  Sdr: a
    .model({
      name: a.string().required(),
      latitude: a.float(),
      longitude: a.float(),
      locationGranularity: a.enum(['EXACT', 'CITY', 'REGION']),
      publicVisible: a.boolean().default(false),
      // Owner FK to User (#248). Survives the owner's self-deletion — Sdr +
      // its recordings stay attached to the (PII-blanked) User row.
      ownerId: a.id(),
      owner: a.belongsTo('User', 'ownerId'),
    })
    .authorization((allow) => [
      allow.authenticated().to(['read']),
      allow.owner().to(['read', 'create', 'update', 'delete']),
      allow.groups(['admin']).to(['read', 'update', 'delete']),
    ]),

  Transmitter: a
    .model({
      name: a.string().required(),
      latitude: a.float().required(),
      longitude: a.float().required(),
      callsign: a.string(),
      notes: a.string(),
    })
    .authorization((allow) => [
      allow.guest().to(['read']),
      allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
    ]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
  },
});
