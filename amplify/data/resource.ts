import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { User } from './models/user';
import { Message } from './models/message';
import { Recording } from './models/recording';
import { Sdr } from './models/sdr';
import { Transmitter } from './models/transmitter';
import { Comment } from './models/comment';
import { FieldVote } from './models/field-vote';
import { TranscriptRevision } from './models/transcript-revision';
import { RevisionVote } from './models/revision-vote';
import { Reputation } from './models/reputation';
import { AbuseReport } from './models/abuse-report';
import { AuditLog } from './models/audit-log';
import { Callsign } from './models/callsign';
import { Donation } from './models/donation';
import { NotificationPreference } from './models/notification-preference';
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
const schema = a.schema({
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
  EmailSuppression,
  SuppressionReason,

  // Audit
  AuditLog,

  // SES bounce/complaint suppression — issue #249
  suppressEmail,
  isSuppressed,
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
  },
});
