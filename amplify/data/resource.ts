import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

/**
 * Initial Amplify Gen 2 data model for Autonomous Sentinel.
 *
 * This is a stub — covers the core entities so the sandbox spins up cleanly.
 * Each model will grow significantly: vote tables, audit log, callsign dictionary,
 * transmitters, abuse reports, donations, etc.
 *
 * Modeling notes (per CLAUDE.md):
 *   - One Message → many Recordings (multi-SDR capture).
 *   - Recordings dedup by content hash.
 *   - UTC timestamps in storage.
 *   - Soft deletes everywhere; audit log is the source of truth.
 *   - GraphQL is anon-readable for public browse (legacy site behavior).
 */
const schema = a.schema({
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
      ownerId: a.id(),
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
