/**
 * AppSync subscription filter predicates + selection sets (#70).
 *
 * Amplify Gen 2's `defineData` auto-generates `onUpdate*` /
 * `onCreate*` / `onDelete*` subscriptions per `@model`. Those
 * fire on EVERY row mutation, so the consumer (web client hook,
 * notification dispatcher) must filter the stream client-side
 * to surface only the events that matter — a status change on
 * a Recording, a public-publish on a Message.
 *
 * Pure JS. The deferred web hooks (`useRecordingStatus(id)`,
 * `usePublishedMessages()`) call `isRecordingStatusChange` /
 * `isPublishableMessage` against each received event to decide
 * whether to surface it to the React tree.
 *
 * Per CLAUDE.md → Pipeline components ("Live updates pushed via
 * AppSync subscription to all connected clients") + → Pages /
 * UX surfaces → My Uploads dashboard ("cheap via a DynamoDB
 * status field + AppSync subscription").
 */

/**
 * Recording fields the My Uploads + admin status-watch consumers
 * care about. Used as the GraphQL subscription selection set so
 * the server doesn't ship irrelevant columns over the wire.
 */
export const RECORDING_STATUS_FIELDS = [
  'id',
  'transcriptionStatus',
  'transcriptionStatusUpdatedAt',
  'failedReason',
  'deletedAt',
  'uploaderId',
  'messageId',
] as const;

/**
 * Message fields the public feed needs to render a card. Same
 * rationale as `RECORDING_STATUS_FIELDS` — narrow set keeps the
 * subscription payload small at 100s of concurrent subscribers.
 */
export const MESSAGE_PUBLISHED_FIELDS = [
  'id',
  'type',
  'sender',
  'receiver',
  'body',
  'broadcastTs',
  'publishedAt',
  'flaggedForReview',
  'deletedAt',
] as const;

/* ----- Recording status change ----------------------------- */

export interface RecordingStatusEvent {
  id?: string | null;
  transcriptionStatus?: string | null;
  transcriptionStatusUpdatedAt?: string | null;
  failedReason?: string | null;
  deletedAt?: string | null;
}

/**
 * Returns true when `next.transcriptionStatus` differs from
 * `prev.transcriptionStatus`. AppSync's auto-generated
 * `onUpdateRecording` subscription fires on EVERY field update —
 * a comment thread bump, a softDelete write, a metadata edit —
 * so the My Uploads hook needs to filter for the actual status
 * delta to avoid spurious re-renders.
 *
 * Defensive: an event with no `transcriptionStatus` field
 * (e.g. soft-delete only flipped `deletedAt`) returns `false`.
 * Caller's responsibility to also subscribe to soft-delete via
 * a separate predicate if needed.
 */
export function isRecordingStatusChange(
  prev: RecordingStatusEvent | null | undefined,
  next: RecordingStatusEvent | null | undefined,
): boolean {
  if (!next || typeof next.transcriptionStatus !== 'string') return false;
  if (!prev) return true; // first event for this id
  if (typeof prev.transcriptionStatus !== 'string') return true;
  return prev.transcriptionStatus !== next.transcriptionStatus;
}

/* ----- Message publish gate ------------------------------- */

export interface PublishableMessage {
  id?: string | null;
  publishedAt?: string | null;
  deletedAt?: string | null;
}

/**
 * Returns true when a Message row is eligible to land in the
 * public feed: `publishedAt != null AND deletedAt == null`.
 * Per CLAUDE.md → Pipeline components → DynamoDB → Message:
 * confidence-gated entries publish (flagged or clean); failed
 * transcriptions don't carry a publishedAt; soft-deleted rows
 * are hidden from public view.
 *
 * Flagged-for-review entries are still publishable — the public
 * feed renders them with a "needs review" banner, not hides them.
 */
export function isPublishableMessage(msg: PublishableMessage | null | undefined): boolean {
  if (!msg) return false;
  if (typeof msg.publishedAt !== 'string') return false;
  if (msg.publishedAt === '') return false;
  if (typeof msg.deletedAt === 'string' && msg.deletedAt !== '') return false;
  return true;
}

/* ----- Recording soft-delete gate ------------------------- */

/**
 * Returns true when an event represents a fresh soft-delete
 * transition. Useful for the My Uploads hook to remove a row
 * the owner just deleted (or that an admin deleted on them).
 */
export function isRecordingSoftDelete(
  prev: RecordingStatusEvent | null | undefined,
  next: RecordingStatusEvent | null | undefined,
): boolean {
  if (!next || typeof next.deletedAt !== 'string' || next.deletedAt === '') return false;
  if (!prev) return true;
  const prevDeleted = typeof prev.deletedAt === 'string' && prev.deletedAt !== '';
  return !prevDeleted;
}
