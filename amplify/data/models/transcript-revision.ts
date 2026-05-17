import { a } from '@aws-amplify/backend';
import { transcriptRevisionMutations } from '../../functions/transcriptRevisionMutations/resource';

/**
 * TranscriptRevision — a proposed alternative transcript for a Recording (#34).
 *
 * Two custom mutations own writes (#287):
 *   - `submitTranscriptRevision` — authenticated. Gated to
 *     Recordings with `transcriptionFailed=true` per CLAUDE.md
 *     "Manual transcription" rule. Comments are the right surface
 *     for successfully-transcribed recordings.
 *   - `acceptTranscriptRevision` — admin/mod. Flips `accepted=true`,
 *     cascades `superseded=true` to siblings on the same Recording,
 *     rewrites `Recording.transcript`, emits `MESSAGE_EDIT` audit.
 *
 * `source` distinguishes:
 *   - `MACHINE` — produced by the Whisper / transcribe Lambda
 *   - `MANUAL` — user-submitted on a `transcriptionFailed=true` Recording
 *   - `CORRECTION` — user proposes a fix to a previously accepted transcript
 *     (separate flow; lands later)
 */
export const TranscriptRevision = a
  .model({
    recordingId: a.id().required(),
    recording: a.belongsTo('Recording', 'recordingId'),
    proposedText: a.string().required(),
    // Cognito sub of the proposer — `User.id = cognitoSub` (#259).
    proposedBy: a.id().required(),
    proposedByUser: a.belongsTo('User', 'proposedBy'),
    source: a.enum(['MACHINE', 'MANUAL', 'CORRECTION']),
    voteScore: a.float().default(0),
    accepted: a.boolean().default(false),
    acceptedAt: a.datetime(),
    superseded: a.boolean().default(false),
    revisionVotes: a.hasMany('RevisionVote', 'revisionId'),
  })
  .secondaryIndexes((i) => [
    i('recordingId').sortKeys(['voteScore']),
    // Required for the legacy-claim FK fan-out (#273) — Query by proposedBy
    // to find every TranscriptRevision a freshly-claimed user submitted.
    i('proposedBy'),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    // No `create` on the model — `submitTranscriptRevision` is the
    // sole write path so the server can enforce the
    // transcriptionFailed gate + force `source=MANUAL` +
    // `proposedBy` from the identity. Leaving auto-generated
    // `createTranscriptRevision` live would let a client supply
    // proposedBy + bypass the gate.
    allow.authenticated().to(['read']),
    allow.groups(['moderator', 'admin']).to(['read', 'update']),
  ]);

/**
 * `submitTranscriptRevision` — authenticated manual submission (#287).
 *
 * Gated to Recordings with `transcriptionFailed=true` per CLAUDE.md.
 * `proposedBy` derived from `ctx.identity.sub`; `source` forced to
 * `MANUAL`. The server-side check is the only thing keeping
 * recording-less spam off the comment / revision surface (per the
 * recording-less submission flow tracked at #285).
 */
export const submitTranscriptRevision = a
  .mutation()
  .arguments({
    recordingId: a.id().required(),
    proposedText: a.string().required(),
  })
  .returns(a.ref('TranscriptRevision'))
  .authorization((allow) => allow.authenticated())
  .handler(a.handler.function(transcriptRevisionMutations));

/**
 * `acceptTranscriptRevision` — admin/mod accept + cascade (#287).
 *
 * Flips the target revision to `accepted=true`, cascades
 * `superseded=true` to siblings on the same Recording, rewrites
 * `Recording.transcript`. Emits a `MESSAGE_EDIT` AuditLog entry
 * targeting the Recording (transcript lives there). Idempotent
 * on already-accepted revisions.
 */
export const acceptTranscriptRevision = a
  .mutation()
  .arguments({
    revisionId: a.id().required(),
  })
  .returns(a.ref('TranscriptRevision'))
  .authorization((allow) => allow.authenticated())
  .handler(a.handler.function(transcriptRevisionMutations));
