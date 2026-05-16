import { a } from '@aws-amplify/backend';

/**
 * SDR — a software-defined radio registered by a user (issue #30).
 *
 * Owner FK to User (#248); survives the owner's self-deletion with PII blanked
 * (name + exact lat/lon wiped when granularity is EXACT). Lat/lon are
 * user-chosen via the map selector with user-selectable granularity (EXACT /
 * CITY / REGION). The owner's `publicVisible` toggle controls whether the SDR
 * appears on the propagation map; non-public SDRs are still readable by
 * authenticated users for cross-reference but excluded from guest reads.
 *
 * Deferred to follow-ups:
 *   - Custom public-listing resolver that filters out non-publicVisible rows
 *     and blurs lat/lon by granularity (`a.authorization` cannot express
 *     per-row visibility on its own).
 *   - PII-blanking cascade on owner self-deletion (rides on the same custom
 *     mutation tracked off #248).
 */
export const Sdr = a
  .model({
    name: a.string().required(),
    latitude: a.float(),
    longitude: a.float(),
    locationGranularity: a.enum(['EXACT', 'CITY', 'REGION']),
    publicVisible: a.boolean().default(false),
    notes: a.string(),
    // Optional admin-attributed transmitter
    transmitterId: a.id(),
    transmitter: a.belongsTo('Transmitter', 'transmitterId'),
    // Owner FK to User (#248).
    ownerId: a.id(),
    owner: a.belongsTo('User', 'ownerId'),
    recordings: a.hasMany('Recording', 'sdrId'),
    deletedAt: a.datetime(),
  })
  .authorization((allow) => [
    allow.authenticated().to(['read']),
    allow.owner().to(['read', 'create', 'update', 'delete']),
    allow.groups(['admin']).to(['read', 'update', 'delete']),
  ]);
