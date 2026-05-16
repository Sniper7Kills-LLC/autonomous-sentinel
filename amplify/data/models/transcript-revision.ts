import { a } from '@aws-amplify/backend';

/**
 * TranscriptRevision — a proposed alternative transcript for a Recording (#34).
 *
 * Manual submissions are gated to recordings with `transcriptionFailed=true`
 * (per CLAUDE.md "Manual transcription" rule). Comments on successfully-
 * transcribed recordings use the Comment + abuse-flag system instead — that
 * gate is enforced by the custom create mutation (deferred).
 *
 * `voteScore` is the running weighted sum from RevisionVote rows. When a
 * revision is accepted, sibling revisions on the same Recording get
 * `superseded=true` and the Recording's `transcript` is rewritten.
 *
 * `source` distinguishes:
 *   - `MACHINE` — produced by the Whisper / transcribe Lambda
 *   - `MANUAL` — user-submitted on a `transcriptionFailed=true` Recording
 *   - `CORRECTION` — user proposes a fix to a previously accepted transcript
 *
 * Deferred:
 *   - Create-mutation gate (only allows `MANUAL` if Recording.transcriptionFailed).
 *   - Accept-cascade (set sibling.superseded=true + update Recording.transcript +
 *     write AuditLog entry).
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
  .secondaryIndexes((i) => [i('recordingId').sortKeys(['voteScore'])])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.authenticated().to(['read', 'create']),
    allow.groups(['moderator', 'admin']).to(['read', 'update']),
  ]);
