import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { User, selfDelete, banUser, getUserPublic } from './models/user';
import { userMutations } from '../functions/userMutations/resource';
import { postConfirmation } from '../functions/postConfirmation/resource';
import { messageMutations } from '../functions/messageMutations/resource';
import { recordingMutations } from '../functions/recordingMutations/resource';
import { commentMutations } from '../functions/commentMutations/resource';
import { getUserPublicLambda } from '../functions/getUserPublicLambda/resource';
import { listAuditLogPublic } from '../functions/listAuditLogPublic/resource';
import { Message, softDeleteMessage } from './models/message';
import { Recording, softDeleteRecording, submitRecording } from './models/recording';
import { Sdr, listSdrPublic } from './models/sdr';
import { listSdrPublicLambda } from '../functions/listSdrPublicLambda/resource';
import { Transmitter } from './models/transmitter';
import { Comment, createComment, softDeleteComment } from './models/comment';
import { FieldVote, FieldVoteField, castFieldVote } from './models/field-vote';
import {
  TranscriptRevision,
  submitTranscriptRevision,
  acceptTranscriptRevision,
} from './models/transcript-revision';
import { transcriptRevisionMutations } from '../functions/transcriptRevisionMutations/resource';
import { RevisionVote, RevisionVoteValue, castRevisionVote } from './models/revision-vote';
import { Reputation } from './models/reputation';
import { AbuseReport } from './models/abuse-report';
import { AuditLog, listAuditLogPublic as listAuditLogPublicQuery } from './models/audit-log';
import { Callsign } from './models/callsign';
import { Donation } from './models/donation';
import {
  NotificationPreference,
  NotificationPreferenceView,
  getNotificationPreference,
  setNotificationPreference,
} from './models/notification-preference';
import { notificationPreferenceMutations } from '../functions/notificationPreferenceMutations/resource';
import { BannedRegionPage } from './models/banned-region-page';
import { LinguisticConfig } from './models/linguistic-config';
import {
  EmailSuppression,
  SuppressionReason,
  suppressEmail,
  isSuppressed,
} from './models/email-suppression';

/**
 * Amplify Gen 2 data model for Autonomous Sentinel.
 *
 * Each model lives in its own file under `./models/`; this file only composes
 * them into the single schema Amplify expects + wires the authorization
 * defaults. New models register here and stay there.
 *
 * Modeling notes (per CLAUDE.md):
 *   - One Message → many Recordings (multi-SDR capture).
 *   - Recordings dedup by content hash.
 *   - UTC timestamps in storage.
 *   - Soft deletes everywhere; AuditLog is the source of truth.
 *   - GraphQL is anon-readable for public browse (legacy site behavior).
 */
export const schema = a
  .schema({
    // Identity + reputation
    User,
    Reputation,

    // Broadcast catalog
    Message,
    Recording,
    Sdr,
    Transmitter,

    // Community
    Comment,
    FieldVote,
    FieldVoteField,
    TranscriptRevision,
    RevisionVote,
    AbuseReport,

    // Reference data
    Callsign,
    LinguisticConfig,
    BannedRegionPage,

    // Money + accounts
    Donation,
    NotificationPreference,
    NotificationPreferenceView,
    EmailSuppression,
    SuppressionReason,

    // Audit
    AuditLog,

    // SES bounce/complaint suppression — issue #249
    suppressEmail,
    isSuppressed,

    // Synthesised composite-PK FieldVote upsert — issue #266
    castFieldVote,

    // RevisionVote enum + upsert (compound-PK + weight-snapshot) — issue #35
    RevisionVoteValue,
    castRevisionVote,

    // User lifecycle mutations + PII-filtered read — issue #248
    selfDelete,
    banUser,
    getUserPublic,

    // Message soft-delete — issue #28
    softDeleteMessage,

    // Recording soft-delete — issue #29
    softDeleteRecording,

    // Recording authenticated upload + contentHash uniqueness — issue #284
    submitRecording,

    // Comment create + soft-delete — issue #32
    createComment,
    softDeleteComment,

    // AuditLog public-filtered read — issue #38
    listAuditLogPublicQuery,

    // TranscriptRevision gated submit + accept-cascade — issue #287
    submitTranscriptRevision,
    acceptTranscriptRevision,

    // Sdr public listing with granularity-blurred lat/lon — issue #286
    listSdrPublic,

    // NotificationPreference KMS-encrypted webhook URL + lazy-create — issue #288
    getNotificationPreference,
    setNotificationPreference,
  })
  .authorization((allow) => [
    // Schema-level Lambda access grants.
    //   - userMutations: queries User to load the target row + AuditLog
    //     for the post-mutation audit; mutates User + AuditLog. (#248)
    //   - postConfirmation: creates the freshly-signed-up User row from
    //     the Cognito event identity. (#15)
    //   - messageMutations: queries Message + AuditLog; mutates Message
    //     + AuditLog. (#28)
    allow.resource(userMutations).to(['query', 'mutate']),
    allow.resource(postConfirmation).to(['query', 'mutate']),
    allow.resource(messageMutations).to(['query', 'mutate']),
    allow.resource(recordingMutations).to(['query', 'mutate']),
    allow.resource(commentMutations).to(['query', 'mutate']),
    allow.resource(transcriptRevisionMutations).to(['query', 'mutate']),
    // listAuditLogPublic Lambda Queries AuditLog directly via the
    // Amplify Data client; `query` scope is enough.
    allow.resource(listAuditLogPublic).to(['query']),
    // getUserPublicLambda is registered here as a data-source
    // consumer for completeness even though its production path
    // reads User directly via the DDB SDK (with the IAM grant in
    // `backend.ts`). The `query` scope leaves room for a future
    // switch to the Amplify Data client without re-touching the
    // schema-level grant.
    allow.resource(getUserPublicLambda).to(['query']),
    // listSdrPublicLambda reads Sdr directly via the DDB SDK (Scan
    // — see handler comment). The `query` scope keeps room for a
    // future switch to the Amplify Data client without re-touching
    // the schema-level grant.
    allow.resource(listSdrPublicLambda).to(['query']),
    // notificationPreferenceMutations reads / writes the
    // NotificationPreference table directly via the DDB SDK (GetItem
    // + UpdateItem — see handler comment). The `query` + `mutate`
    // scopes keep room for a future switch to the Amplify Data
    // client without re-touching the schema-level grant.
    allow.resource(notificationPreferenceMutations).to(['query', 'mutate']),
  ]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
  },
});
