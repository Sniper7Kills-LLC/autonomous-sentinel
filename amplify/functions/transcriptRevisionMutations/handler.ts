import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for TranscriptRevision custom
 * mutations (#287 / #34).
 *
 * Two dispatch cases:
 *
 *   - `submitTranscriptRevision` — authenticated. Gates creation
 *     to Recordings whose `transcriptionFailed=true` (per
 *     CLAUDE.md "Manual transcription" rule). `proposedBy` set
 *     from `ctx.identity.sub`; `source` hardcoded to `MANUAL`
 *     (the only path users can submit through). Successfully-
 *     transcribed recordings reject revision creation — comments
 *     are the right surface for those.
 *
 *   - `acceptTranscriptRevision` — admin/mod. Flips the target
 *     revision to `accepted=true` + `acceptedAt=now`, cascades
 *     `superseded=true` to all sibling revisions on the same
 *     Recording, rewrites `Recording.transcript` to the accepted
 *     text. Emits a `MESSAGE_EDIT` AuditLog entry targeting the
 *     parent Recording (transcript lives there). Idempotent on
 *     already-accepted revisions.
 *
 *     **Race trade-off**: the sibling-cascade reads the live
 *     revision list once via the GSI. A
 *     `submitTranscriptRevision` arriving mid-cascade can land a
 *     new revision with `superseded=false` after the list is
 *     snapshotted. The new revision is harmless in practice
 *     because the public revision-list query orders by `voteScore`
 *     (the accepted revision already won), but admins may see a
 *     stray live sibling. Acceptable trade-off for v1; tighten
 *     with a DDB conditional-write Recording-level guard if it
 *     becomes observable.
 *
 * MACHINE / CORRECTION sources are out of scope for these
 * mutations:
 *   - `MACHINE` rows are inserted by the transcribe Lambda
 *     directly (phase 3 pipeline).
 *   - `CORRECTION` rows belong to a separate "user corrects an
 *     already-accepted transcript" flow that lands later.
 */

export type TranscriptRevisionRow = {
  id: string;
  recordingId: string;
  proposedText: string;
  proposedBy: string;
  source?: string | null;
  voteScore?: number | null;
  accepted?: boolean | null;
  acceptedAt?: string | null;
  superseded?: boolean | null;
  [k: string]: unknown;
};

export type RecordingRow = {
  id: string;
  transcript?: string | null;
  transcriptionFailed?: boolean | null;
  messageId?: string | null;
  [k: string]: unknown;
};

export interface TranscriptRevisionMutationsDataClient {
  models: {
    Recording: {
      get: (input: { id: string }) => Promise<{
        data: RecordingRow | null;
        errors?: unknown;
      }>;
      update: (
        input: Partial<RecordingRow> & { id: string },
      ) => Promise<{ data: RecordingRow | null; errors?: unknown }>;
    };
    TranscriptRevision: {
      get: (input: { id: string }) => Promise<{
        data: TranscriptRevisionRow | null;
        errors?: unknown;
      }>;
      create: (input: Omit<TranscriptRevisionRow, 'id'>) => Promise<{
        data: TranscriptRevisionRow | null;
        errors?: unknown;
      }>;
      update: (
        input: Partial<TranscriptRevisionRow> & { id: string },
      ) => Promise<{ data: TranscriptRevisionRow | null; errors?: unknown }>;
      /**
       * GSI lookup auto-generated for the `i('recordingId').sortKeys(['voteScore'])`
       * index on TranscriptRevision (#257). Used by the accept-cascade
       * to find sibling revisions on the same Recording.
       */
      listTranscriptRevisionByRecordingIdAndVoteScore: (input: {
        recordingId: string;
      }) => Promise<{ data: TranscriptRevisionRow[] | null; errors?: unknown }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

interface Deps {
  dataClient?: TranscriptRevisionMutationsDataClient;
  audit?: AuditFn;
  now?: () => Date;
}

let injected: Deps = {};

export function __setDeps(deps: Deps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedDefaultClient: TranscriptRevisionMutationsDataClient | undefined;

async function getDefaultClient(): Promise<TranscriptRevisionMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as TranscriptRevisionMutationsDataClient;
  return cachedDefaultClient;
}

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function identityGroups(identity: unknown): readonly string[] {
  if (!identity || typeof identity !== 'object') return [];
  const groups = (identity as { groups?: unknown }).groups;
  return Array.isArray(groups) ? (groups as readonly string[]) : [];
}

function isModOrAdmin(identity: unknown): boolean {
  const g = identityGroups(identity);
  return g.indexOf('moderator') >= 0 || g.indexOf('admin') >= 0;
}

function auditContextFrom(event: {
  identity?: unknown;
  request?: { headers?: Record<string, string | undefined> };
}): AuditContext {
  const sub = identitySub(event.identity);
  return {
    identity: sub ? { sub } : null,
    request: { headers: event.request?.headers ?? {} },
  };
}

function snapshot<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return { ...row };
}

async function dispatchSubmit(
  event: Parameters<
    AppSyncResolverHandler<Record<string, unknown>, TranscriptRevisionRow | null>
  >[0],
  deps: { client: TranscriptRevisionMutationsDataClient; now: () => Date },
): Promise<TranscriptRevisionRow | null> {
  const authorSub = identitySub(event.identity);
  if (!authorSub) {
    throw new Error('submitTranscriptRevision: caller has no identity sub');
  }
  const args = event.arguments;
  const recordingId = typeof args.recordingId === 'string' ? args.recordingId : '';
  const proposedText = typeof args.proposedText === 'string' ? args.proposedText : '';
  if (!recordingId) {
    throw new Error('submitTranscriptRevision: recordingId argument is required');
  }
  if (!proposedText) {
    throw new Error('submitTranscriptRevision: proposedText argument is required');
  }

  const recFetch = await deps.client.models.Recording.get({ id: recordingId });
  const recording = recFetch.data;
  if (!recording) {
    throw new Error(`submitTranscriptRevision: Recording not found for id=${recordingId}`);
  }
  if (!recording.transcriptionFailed) {
    // CLAUDE.md "Manual transcription" rule — comments are the
    // right surface for successfully-transcribed recordings.
    throw new Error(
      `submitTranscriptRevision: Recording ${recordingId} has transcriptionFailed=false; use comments instead`,
    );
  }

  const created = await deps.client.models.TranscriptRevision.create({
    recordingId,
    proposedText,
    proposedBy: authorSub,
    source: 'MANUAL',
    voteScore: 0,
    accepted: false,
    superseded: false,
  });
  if (created.errors) {
    throw new Error(
      `submitTranscriptRevision: TranscriptRevision.create returned errors: ${JSON.stringify(created.errors)}`,
    );
  }
  return created.data;
}

async function dispatchAccept(
  event: Parameters<
    AppSyncResolverHandler<Record<string, unknown>, TranscriptRevisionRow | null>
  >[0],
  deps: {
    client: TranscriptRevisionMutationsDataClient;
    audit: AuditFn;
    now: () => Date;
  },
): Promise<TranscriptRevisionRow | null> {
  if (!isModOrAdmin(event.identity)) {
    throw new Error('acceptTranscriptRevision: caller is not in the moderator or admin group');
  }
  const args = event.arguments;
  const revisionId = typeof args.revisionId === 'string' ? args.revisionId : '';
  if (!revisionId) {
    throw new Error('acceptTranscriptRevision: revisionId argument is required');
  }

  const revFetch = await deps.client.models.TranscriptRevision.get({ id: revisionId });
  const target = revFetch.data;
  if (!target) {
    throw new Error(
      `acceptTranscriptRevision: TranscriptRevision row not found for id=${revisionId}`,
    );
  }
  if (target.accepted) {
    // Idempotent — already accepted. Return the row untouched.
    return target;
  }

  const now = deps.now().toISOString();

  // Step 1: flip accepted=true / acceptedAt on the target.
  const acceptedPatch: Partial<TranscriptRevisionRow> & { id: string } = {
    id: revisionId,
    accepted: true,
    acceptedAt: now,
  };
  const updated = await deps.client.models.TranscriptRevision.update(acceptedPatch);
  if (updated.errors) {
    throw new Error(
      `acceptTranscriptRevision: TranscriptRevision.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }

  // Step 2: cascade superseded=true to every sibling revision on
  // the same Recording (excluding the freshly-accepted one).
  const siblingsFetch =
    await deps.client.models.TranscriptRevision.listTranscriptRevisionByRecordingIdAndVoteScore({
      recordingId: target.recordingId,
    });
  const siblings = (siblingsFetch.data ?? []).filter((r) => r.id !== revisionId && !r.superseded);
  for (const sibling of siblings) {
    await deps.client.models.TranscriptRevision.update({
      id: sibling.id,
      superseded: true,
    });
  }

  // Step 3: rewrite Recording.transcript to the accepted text.
  const recordingFetch = await deps.client.models.Recording.get({ id: target.recordingId });
  const recordingBefore = recordingFetch.data;
  if (!recordingBefore) {
    // Shouldn't happen if FK integrity holds, but defensive:
    throw new Error(`acceptTranscriptRevision: parent Recording ${target.recordingId} not found`);
  }
  const recordingUpdate = await deps.client.models.Recording.update({
    id: target.recordingId,
    transcript: target.proposedText,
  });
  const recordingAfter = recordingUpdate.data ?? {
    ...recordingBefore,
    transcript: target.proposedText,
  };

  // Step 4: audit entry. Target is the Recording — the transcript
  // change is observable as a content edit on the broadcast.
  await deps.audit(auditContextFrom(event), {
    action: 'MESSAGE_EDIT',
    targetType: 'Recording',
    targetId: target.recordingId,
    before: snapshot(recordingBefore),
    after: snapshot(recordingAfter),
    reason: `Accepted TranscriptRevision ${revisionId}`,
  });

  return updated.data ?? { ...target, ...acceptedPatch };
}

export const handler: AppSyncResolverHandler<
  Record<string, unknown>,
  TranscriptRevisionRow | null
> = async (event) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());

  const field = event.info.fieldName;
  switch (field) {
    case 'submitTranscriptRevision':
      return dispatchSubmit(event, { client, now });
    case 'acceptTranscriptRevision':
      return dispatchAccept(event, { client, audit: auditFn, now });
    default:
      throw new Error(`transcriptRevisionMutations: unsupported fieldName "${field}"`);
  }
};
