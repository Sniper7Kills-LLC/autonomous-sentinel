import { a } from '@aws-amplify/backend';
import { listSdrPublicLambda } from '../../functions/listSdrPublicLambda/resource';
import { sdrMutations } from '../../functions/sdrMutations/resource';

/**
 * SDR — a software-defined radio registered by a user (issue #30).
 *
 * Two distinct kinds (#785):
 *   - OWNED — a receiver a member operates and feeds the site from. The
 *     member owns the row. `publicVisible` toggle controls map visibility
 *     (no admin review). Usually has no public URL.
 *   - PUBLIC — a third-party public receiver (KiwiSDR / WebSDR / U.Twente).
 *     A member *submits* it with its stream `url`. Lands PENDING → admin
 *     review → only APPROVED rows appear on the map.
 *
 * Owner FK to User (#248); survives the owner's self-deletion with PII blanked
 * (name replaced by `[deleted]`, notes wiped, lat/lon wiped when granularity is
 * EXACT — see `userMutations.selfDelete` cascade). Lat/lon are user-chosen via
 * the map selector with user-selectable granularity (EXACT / CITY / REGION).
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
    // #785 — SDR kind: OWNED (member-operated feeder) vs PUBLIC (third-party
    // public receiver submitted for admin review).
    kind: a.enum(['OWNED', 'PUBLIC']),
    // Public stream URL — required for PUBLIC SDRs (KiwiSDR / WebSDR / U.Twente).
    // Optional / absent for OWNED SDRs (private feeders have no public URL).
    url: a.string(),
    // Review workflow for PUBLIC SDRs (#785). OWNED SDRs omit this field
    // (treated as n/a; the owner toggle drives map visibility instead).
    reviewStatus: a.enum(['PENDING', 'APPROVED', 'REJECTED']),
    // Cognito sub of the admin who reviewed the PUBLIC SDR.
    reviewedBy: a.id(),
    reviewedAt: a.datetime(),
    reviewNote: a.string(),
    // Who submitted a PUBLIC SDR. May differ from ownerId (PUBLIC rows have
    // no member owner — ownerId is null for PUBLIC rows).
    submitterId: a.id(),
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
    // #785 — Query by submitterId for the member's SDR listing + admin review
    // queue (pending public submissions from a given user).
    i('submitterId'),
  ])
  .authorization((allow) => [
    allow.authenticated().to(['read']),
    // #430 Cognito-group sweep — admin already covered by the
    // elevated rule below; Amplify @auth rejects the same group in
    // two `allow.groups(...)` rules per model.
    allow.groups(['moderator', 'member']).to(['read']),
    // Owner = the Cognito sub stored in `ownerId`. Explicit binding required
    // because `allow.owner()` defaults to a field literally named `owner`.
    // Members can create OWNED rows (owner-defined-in binding) but NOT
    // PUBLIC rows directly — those go through submitPublicSdr Lambda which
    // sets kind=PUBLIC + reviewStatus=PENDING server-side.
    allow.ownerDefinedIn('ownerId').identityClaim('sub').to(['read', 'create', 'update', 'delete']),
    allow.groups(['admin']).to(['read', 'update', 'delete']),
    // Note: sdrMutations Lambda access is granted at the schema level in
    // amplify/data/resource.ts via `allow.resource(sdrMutations)`, which
    // injects AMPLIFY_DATA_* env vars and grants AppSync-IAM access.
    // The Lambda uses IAM auth mode (generateClient({ authMode: 'iam' })),
    // so it bypasses model-level @auth rules and operates as a trusted system
    // principal — same pattern as messageMutations, recordingMutations, etc.
  ]);

/**
 * `listSdrPublic` — public-facing Sdr listing (issue #286).
 *
 * Guests + authenticated callers hit this for the propagation map.
 * The Lambda filters soft-deleted rows for everyone, then for non-
 * admin callers also filters:
 *   - OWNED rows where `publicVisible=true`
 *   - PUBLIC rows where `reviewStatus=APPROVED`
 * with lat/lon blurred per the owner's `locationGranularity` (EXACT → no blur,
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
  // #430: pair authenticated with every named group so members /
  // moderators / admins reach the query through their group IAM role.
  .authorization((allow) => [
    allow.guest(),
    allow.authenticated(),
    allow.groups(['admin', 'moderator', 'member']),
  ])
  .handler(a.handler.function(listSdrPublicLambda));

/**
 * `submitPublicSdr` — member mutation to submit a PUBLIC SDR for admin review (#785).
 *
 * Sets kind=PUBLIC, submitterId=caller, reviewStatus=PENDING, ownerId=null.
 * Writes a SDR_SUBMIT_PUBLIC AuditLog entry.
 * Resolved by the sdrMutations Lambda.
 */
export const submitPublicSdr = a
  .mutation()
  .arguments({
    name: a.string().required(),
    url: a.string().required(),
    latitude: a.float(),
    longitude: a.float(),
    locationGranularity: a.string(),
    notes: a.string(),
  })
  .returns(a.ref('Sdr'))
  .authorization((allow) => [
    allow.authenticated(),
    allow.groups(['admin', 'moderator', 'member']),
  ])
  .handler(a.handler.function(sdrMutations));

/**
 * `reviewSdr` — admin mutation to approve or reject a PUBLIC SDR submission (#785).
 *
 * Sets reviewStatus, reviewedBy=caller, reviewedAt=now, reviewNote.
 * Writes a SDR_REVIEW AuditLog entry. Admin-only.
 * Resolved by the sdrMutations Lambda.
 */
export const reviewSdr = a
  .mutation()
  .arguments({
    sdrId: a.string().required(),
    decision: a.string().required(),
    note: a.string(),
  })
  .returns(a.ref('Sdr'))
  .authorization((allow) => [allow.groups(['admin'])])
  .handler(a.handler.function(sdrMutations));
