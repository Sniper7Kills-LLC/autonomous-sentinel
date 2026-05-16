import { a } from '@aws-amplify/backend';

/**
 * Recording — a single audio capture of a broadcast.
 *
 * Content-hashed (deduped on upload). Two persistent S3 keys: `originalKey`
 * is exactly what the uploader sent; `webCanonicalKey` is the Opus 32 kbps
 * mono derivative the pre-process Lambda emits for browser playback. The
 * uploader FK (`uploaderId`) is set by the upload client (phase 6) using the
 * Cognito sub → User row lookup; survives the uploader's self-deletion.
 */
export const Recording = a
  .model({
    messageId: a.id(),
    message: a.belongsTo('Message', 'messageId'),
    // Uploader FK to User (#248).
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
  ]);
