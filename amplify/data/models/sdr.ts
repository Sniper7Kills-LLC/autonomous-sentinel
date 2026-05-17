import { a } from '@aws-amplify/backend';
import { listSdrPublicLambda } from '../../functions/listSdrPublicLambda/resource';

/**
 * SDR — a software-defined radio registered by a user (issue #30).
 *
 * Owner FK to User (#248); survives the owner's self-deletion with PII blanked
 * (name replaced by `[deleted]`, notes wiped, lat/lon wiped when granularity is
 * EXACT — see `userMutations.selfDelete` cascade). Lat/lon are user-chosen via
 * the map selector with user-selectable granularity (EXACT / CITY / REGION).
 * The owner's `publicVisible` toggle controls whether the SDR appears on the
 * propagation map; non-public SDRs are still readable by authenticated users
 * for cross-reference but excluded from guest reads.
 *
 * `recordings` hasMany Recording is intentionally sparse — `Recording.sdrId`
 * is optional because migrated v3 audio and certain admin-imported recordings
 * have no associated SDR. Querying `sdr.recordings` returns only the rows
 * whose `sdrId` actually matches; recordings with `sdrId=null` are excluded
 * by design.
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
    // Owner FK to User (#248). Stores the Cognito sub directly — see #259
    // for the User.id = cognitoSub decision.
    ownerId: a.id(),
    owner: a.belongsTo('User', 'ownerId'),
    recordings: a.hasMany('Recording', 'sdrId'),
    deletedAt: a.datetime(),
  })
  .secondaryIndexes((i) => [
    // Required for the legacy-claim FK fan-out (#273) — Query by ownerId
    // to find every SDR a freshly-claimed user owns.
    i('ownerId'),
  ])
  .authorization((allow) => [
    allow.authenticated().to(['read']),
    // Owner = the Cognito sub stored in `ownerId`. Explicit binding required
    // because `allow.owner()` defaults to a field literally named `owner`.
    allow.ownerDefinedIn('ownerId').identityClaim('sub').to(['read', 'create', 'update', 'delete']),
    allow.groups(['admin']).to(['read', 'update', 'delete']),
  ]);

/**
 * `listSdrPublic` — public-facing Sdr listing (issue #286).
 *
 * Guests + authenticated callers hit this for the propagation map.
 * The Lambda filters soft-deleted rows for everyone, then for non-
 * admin callers also filters down to `publicVisible=true` and blurs
 * lat/lon to the owner's `locationGranularity` (EXACT → no blur,
 * CITY → 1 dp, REGION → 0 dp, unset → null). Admin callers see the
 * un-filtered, un-blurred set so the admin propagation view can pin
 * exact locations.
 *
 * Lambda-backed (vs. `a.handler.custom` JS) so `allow.guest()`
 * works under the identityPool default auth mode — same constraint
 * that forced `getUserPublic` to migrate to a Lambda in #271.
 */
export const listSdrPublic = a
  .query()
  .returns(a.ref('Sdr').array())
  .authorization((allow) => [allow.guest(), allow.authenticated()])
  .handler(a.handler.function(listSdrPublicLambda));
