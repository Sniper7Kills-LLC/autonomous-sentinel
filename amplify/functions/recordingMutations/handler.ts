import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for Recording custom mutations
 * (#29 / #284). Cross-cutting AuditLog helper (#258) is the sole
 * writer of the `RECORDING_*` audit rows.
 *
 * Dispatches on `event.info.fieldName`:
 *   - `softDeleteRecording` — admin-only. Sets `deletedAt` /
 *     `deletedBy` on the Recording row. Idempotent — a second call
 *     on an already-deleted row returns the row untouched.
 *   - `submitRecording` — authenticated. Enforces `contentHash`
 *     uniqueness server-side (#284): Queries the
 *     `recording-contentHash-index` GSI; if any row with the same
 *     hash exists (deleted or not), throws
 *     `RECORDING_DUPLICATE_HASH`. Otherwise creates the row with
 *     `uploaderId` set from `ctx.identity.sub` (never trusted from
 *     the client).
 *
 * Recording carries no `deletedReason` column at the row level (per
 * the model definition in #257); the moderator's reason is captured
 * only on the AuditLog entry.
 *
 * No cascade to the parent Message. The original CLAUDE.md rule
 * ("messages with no recording cease to exist") was reversed when
 * we discovered the v3 archive has Messages with no Recording for
 * analytics + the v4 submission flow will allow recording-less
 * entries gated by a verification step (anti-spam). A Recording
 * delete therefore touches only the Recording row.
 *
 * Deferred (out of scope, tracked separately):
 *   - **S3 hard-delete** of the original / web-canonical / sidecar
 *     keys. Phase 3 / storage lifecycle work — versioning
 *     preserves the 30-day undo window.
 *
 * Returns the post-mutation Recording row.
 */

export type RecordingRow = {
  id: string;
  messageId?: string | null;
  uploaderId?: string | null;
  contentHash?: string | null;
  originalKey?: string | null;
  webCanonicalKey?: string | null;
  durationMs?: number | null;
  frequencyKhz?: number | null;
  modulation?: 'USB' | 'LSB' | 'AM' | 'FM' | null;
  broadcastedAt?: string | null;
  automated?: boolean | null;
  sdrId?: string | null;
  transcriptionStatus?: string | null;
  transcriptionFailed?: boolean | null;
  migratedFromV3?: boolean | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  [k: string]: unknown;
};

export interface RecordingMutationsDataClient {
  models: {
    Recording: {
      get: (input: { id: string }) => Promise<{
        data: RecordingRow | null;
        errors?: unknown;
      }>;
      create: (input: Omit<RecordingRow, 'id'>) => Promise<{
        data: RecordingRow | null;
        errors?: unknown;
      }>;
      update: (
        input: Partial<RecordingRow> & { id: string },
      ) => Promise<{ data: RecordingRow | null; errors?: unknown }>;
      /**
       * GSI lookup auto-generated for `i('contentHash')` on Recording
       * (#257). Used by `submitRecording` (#284) to reject duplicate
       * uploads with the same SHA-256.
       */
      listRecordingByContentHash: (input: { contentHash: string }) => Promise<{
        data: RecordingRow[] | null;
        errors?: unknown;
      }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

interface Deps {
  dataClient?: RecordingMutationsDataClient;
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

let cachedDefaultClient: RecordingMutationsDataClient | undefined;

async function getDefaultClient(): Promise<RecordingMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as RecordingMutationsDataClient;
  return cachedDefaultClient;
}

function isAdmin(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const groups = (identity as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.indexOf('admin') >= 0;
}

function identitySub(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const sub = (identity as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
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

function snapshot(row: RecordingRow): Record<string, unknown> {
  return { ...row };
}

async function dispatchSoftDelete(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: { client: RecordingMutationsDataClient; audit: AuditFn; now: () => Date },
): Promise<RecordingRow | null> {
  if (!isAdmin(event.identity)) {
    throw new Error('softDeleteRecording: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('softDeleteRecording: caller has no identity sub');
  }

  const args = event.arguments;
  const targetId = typeof args.recordingId === 'string' ? args.recordingId : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!targetId) {
    throw new Error('softDeleteRecording: recordingId argument is required');
  }

  const fetched = await deps.client.models.Recording.get({ id: targetId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`softDeleteRecording: Recording row not found for id=${targetId}`);
  }
  if (before.deletedAt) {
    return before;
  }

  const now = deps.now().toISOString();
  const normalisedReason: string | null = reason ? reason : null;

  const patch: Partial<RecordingRow> & { id: string } = {
    id: targetId,
    deletedAt: now,
    deletedBy: actorSub,
  };
  const updated = await deps.client.models.Recording.update(patch);
  if (updated.errors) {
    throw new Error(
      `softDeleteRecording: Recording.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  await deps.audit(auditContextFrom(event), {
    action: 'RECORDING_DELETE',
    targetType: 'Recording',
    targetId,
    before: snapshot(before),
    after: snapshot(after),
    reason: normalisedReason,
  });

  // No cascade to the parent Message: v3 archive + v4
  // recording-less submission flow (see CLAUDE.md → Domain model →
  // Recording) both rely on Messages being independent of their
  // Recording rows.

  return after;
}

/**
 * Typed error code for duplicate-hash rejection so consumers can
 * match without parsing the human message.
 */
const RECORDING_DUPLICATE_HASH = 'RECORDING_DUPLICATE_HASH';

async function dispatchSubmit(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null>>[0],
  deps: { client: RecordingMutationsDataClient; now: () => Date },
): Promise<RecordingRow | null> {
  const uploaderSub = identitySub(event.identity);
  if (!uploaderSub) {
    throw new Error('submitRecording: caller has no identity sub');
  }
  const args = event.arguments;
  const contentHash = typeof args.contentHash === 'string' ? args.contentHash : '';
  const originalKey = typeof args.originalKey === 'string' ? args.originalKey : '';
  if (!contentHash) {
    throw new Error('submitRecording: contentHash argument is required');
  }
  if (!originalKey) {
    throw new Error('submitRecording: originalKey argument is required');
  }

  // Server-side uniqueness check (#284). The GSI on contentHash
  // catches duplicate uploads — same audio bytes → same SHA-256 →
  // hit. Reject regardless of soft-delete state on the existing
  // row: a deleted duplicate still resolves to an existing
  // content_hash that the uniqueness invariant applies to.
  //
  // Race window: a second `submitRecording` arriving between the
  // GSI Query and the Create can clear the duplicate check and
  // land a second row with the same contentHash. Tightening via
  // DDB conditional-write + janitor sweep tracked on #297.
  // Acceptable for v1: collision requires two uploaders racing the
  // exact same audio in the sub-second window between Query and
  // Create.
  //
  // The error intentionally omits the existing row's id — clients
  // get a yes/no answer on whether the hash is taken; they don't
  // need to walk to the existing row.
  const dup = await deps.client.models.Recording.listRecordingByContentHash({ contentHash });
  if (dup.data && dup.data.length > 0) {
    throw new Error(
      `${RECORDING_DUPLICATE_HASH}: a Recording with the same contentHash already exists`,
    );
  }

  // Optional pass-through fields. `messageId` may be null when the
  // recording is uploaded ahead of a Message being attributed (the
  // transcription pipeline links them later, or v3 archive entries
  // are imported without one — per the recording-less / messageless
  // semantics introduced on #285).
  const optional: Partial<RecordingRow> = {};
  if (typeof args.messageId === 'string') optional.messageId = args.messageId;
  if (typeof args.webCanonicalKey === 'string') optional.webCanonicalKey = args.webCanonicalKey;
  if (typeof args.durationMs === 'number') optional.durationMs = args.durationMs;
  if (typeof args.frequencyKhz === 'number') optional.frequencyKhz = args.frequencyKhz;
  if (args.modulation !== undefined && args.modulation !== null) {
    if (
      args.modulation !== 'USB' &&
      args.modulation !== 'LSB' &&
      args.modulation !== 'AM' &&
      args.modulation !== 'FM'
    ) {
      // Fail fast on garbage modulation. The GraphQL enum should
      // already gate this at the AppSync layer, but the handler
      // also rejects so a directly-invoked Lambda (testing, AWS
      // console replay) can't sneak an invalid value past the
      // schema enum. Silent drop would mask a client bug.
      throw new Error(
        `submitRecording: modulation must be one of USB/LSB/AM/FM (got ${JSON.stringify(args.modulation)})`,
      );
    }
    optional.modulation = args.modulation;
  }
  if (typeof args.broadcastedAt === 'string') optional.broadcastedAt = args.broadcastedAt;
  if (typeof args.automated === 'boolean') optional.automated = args.automated;
  if (typeof args.sdrId === 'string') optional.sdrId = args.sdrId;

  const created = await deps.client.models.Recording.create({
    contentHash,
    originalKey,
    uploaderId: uploaderSub,
    transcriptionStatus: 'QUEUED',
    transcriptionFailed: false,
    migratedFromV3: false,
    ...optional,
  });
  if (created.errors) {
    throw new Error(
      `submitRecording: Recording.create returned errors: ${JSON.stringify(created.errors)}`,
    );
  }
  return created.data;
}

export const handler: AppSyncResolverHandler<Record<string, unknown>, RecordingRow | null> = async (
  event,
) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());
  const deps = { client, audit: auditFn, now };

  const field = event.info.fieldName;
  switch (field) {
    case 'softDeleteRecording':
      return dispatchSoftDelete(event, deps);
    case 'submitRecording':
      return dispatchSubmit(event, { client, now });
    default:
      throw new Error(`recordingMutations: unsupported fieldName "${field}"`);
  }
};
