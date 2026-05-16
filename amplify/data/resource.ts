import { type ClientSchema, a, defineData } from '@aws-amplify/backend';
import { User } from './models/user';
import { Message } from './models/message';
import { Recording } from './models/recording';
import { Sdr } from './models/sdr';
import { Transmitter } from './models/transmitter';

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
  User,
  Message,
  Recording,
  Sdr,
  Transmitter,
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
  },
});
