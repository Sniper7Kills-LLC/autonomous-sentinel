import { a } from '@aws-amplify/backend';

/**
 * Message — a single EAM broadcast event.
 *
 * One Message → many Recordings (multiple SDRs catch the same broadcast). The
 * parsed fields (`sender`, `receiver`, `body`, etc.) are derived from the
 * recordings' transcripts via the Linguistic Logic Lambda. Edits append
 * revisions rather than overwriting (audit + community vote — phase 2 #34).
 */
export const Message = a
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
  ]);
