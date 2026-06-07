import type { AppSyncResolverHandler } from 'aws-lambda';
import {
  audit as defaultAudit,
  type AuditContext,
  type AuditOptions,
} from '../../data/audit-log-helper';

/**
 * Lambda-backed AppSync resolver for SDR custom mutations (#785).
 *
 * Dispatches on `event.info.fieldName`:
 *   - `submitPublicSdr` — authenticated members submit a PUBLIC SDR for admin
 *     review. Sets kind=PUBLIC, submitterId=caller sub, reviewStatus=PENDING,
 *     ownerId=null, publicVisible=false. Rejects blank name/url. Writes a
 *     SDR_SUBMIT_PUBLIC AuditLog entry.
 *   - `reviewSdr` — admin-only. Sets reviewStatus ∈ {APPROVED, REJECTED},
 *     reviewedBy=caller, reviewedAt=now, reviewNote. Writes SDR_REVIEW
 *     AuditLog entry. Idempotent (re-review is allowed).
 */

export type SdrRow = {
  id: string;
  name?: string | null;
  kind?: string | null;
  url?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationGranularity?: string | null;
  publicVisible?: boolean | null;
  notes?: string | null;
  reviewStatus?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  submitterId?: string | null;
  ownerId?: string | null;
  deletedAt?: string | null;
  [k: string]: unknown;
};

export interface SdrMutationsDataClient {
  models: {
    Sdr: {
      get: (input: { id: string }) => Promise<{ data: SdrRow | null; errors?: unknown }>;
      create: (
        input: Partial<SdrRow>,
      ) => Promise<{ data: SdrRow | null; errors?: unknown }>;
      update: (
        input: Partial<SdrRow> & { id: string },
      ) => Promise<{ data: SdrRow | null; errors?: unknown }>;
    };
  };
}

export type AuditFn = (ctx: AuditContext, opts: AuditOptions) => Promise<string>;

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

function snapshot(row: SdrRow): Record<string, unknown> {
  return { ...row };
}

interface Deps {
  dataClient?: SdrMutationsDataClient;
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

let cachedDefaultClient: SdrMutationsDataClient | undefined;

async function getDefaultClient(): Promise<SdrMutationsDataClient> {
  if (cachedDefaultClient) return cachedDefaultClient;
  const { configureAmplifyOnce } = await import('../_shared/configure-amplify');
  await configureAmplifyOnce();
  const mod = await import('aws-amplify/data');
  cachedDefaultClient = mod.generateClient({
    authMode: 'iam',
  }) as unknown as SdrMutationsDataClient;
  return cachedDefaultClient;
}

interface SubmitPublicSdrArgs {
  name?: unknown;
  url?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  locationGranularity?: unknown;
  notes?: unknown;
}

const VALID_GRANULARITIES = new Set(['EXACT', 'CITY', 'REGION']);

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function pickFloat(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function dispatchSubmitPublicSdr(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, SdrRow | null>>[0],
  deps: {
    client: SdrMutationsDataClient;
    audit: AuditFn;
    now: () => Date;
  },
): Promise<SdrRow> {
  const sub = identitySub(event.identity);
  if (!sub) {
    throw new Error('submitPublicSdr: caller has no identity (not signed in)');
  }

  const args = event.arguments as SubmitPublicSdrArgs;
  const name = pickString(args.name);
  if (!name) {
    throw new Error('submitPublicSdr: name argument is required and must be non-blank');
  }
  const url = pickString(args.url);
  if (!url) {
    throw new Error('submitPublicSdr: url argument is required and must be non-blank');
  }

  const latitude = pickFloat(args.latitude);
  const longitude = pickFloat(args.longitude);
  const granularityRaw = pickString(args.locationGranularity);
  const locationGranularity =
    granularityRaw && VALID_GRANULARITIES.has(granularityRaw) ? granularityRaw : null;
  const notes = pickString(args.notes);

  const created = await deps.client.models.Sdr.create({
    name,
    url,
    kind: 'PUBLIC',
    submitterId: sub,
    reviewStatus: 'PENDING',
    publicVisible: false,
    // ownerId intentionally null — PUBLIC SDRs have no member owner
    ownerId: undefined,
    ...(latitude !== null ? { latitude } : {}),
    ...(longitude !== null ? { longitude } : {}),
    ...(locationGranularity ? { locationGranularity } : {}),
    ...(notes ? { notes } : {}),
  });

  if (created.errors) {
    throw new Error(
      `submitPublicSdr: Sdr.create returned errors: ${JSON.stringify(created.errors)}`,
    );
  }
  const after = created.data;
  if (!after) {
    throw new Error('submitPublicSdr: Sdr.create returned no data');
  }

  // Audit — best-effort, never roll back on failure
  try {
    await deps.audit(auditContextFrom(event), {
      action: 'SDR_SUBMIT_PUBLIC',
      targetType: 'Sdr',
      targetId: after.id,
      after: snapshot(after),
    });
  } catch (err: unknown) {
    console.warn(
      `submitPublicSdr: audit write failed for sdrId=${after.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return after;
}

interface ReviewSdrArgs {
  sdrId?: unknown;
  decision?: unknown;
  note?: unknown;
}

const VALID_DECISIONS = new Set(['APPROVED', 'REJECTED']);

async function dispatchReviewSdr(
  event: Parameters<AppSyncResolverHandler<Record<string, unknown>, SdrRow | null>>[0],
  deps: {
    client: SdrMutationsDataClient;
    audit: AuditFn;
    now: () => Date;
  },
): Promise<SdrRow> {
  if (!isAdmin(event.identity)) {
    throw new Error('reviewSdr: caller is not in the admin group');
  }
  const actorSub = identitySub(event.identity);
  if (!actorSub) {
    throw new Error('reviewSdr: caller has no identity sub');
  }

  const args = event.arguments as ReviewSdrArgs;
  const sdrId = pickString(args.sdrId);
  if (!sdrId) {
    throw new Error('reviewSdr: sdrId argument is required');
  }
  const decision = typeof args.decision === 'string' ? args.decision : '';
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`reviewSdr: decision must be APPROVED or REJECTED, got "${decision}"`);
  }
  const note = pickString(args.note);

  const fetched = await deps.client.models.Sdr.get({ id: sdrId });
  const before = fetched.data;
  if (!before) {
    throw new Error(`reviewSdr: Sdr row not found for id=${sdrId}`);
  }

  const nowIso = deps.now().toISOString();
  const patch: Partial<SdrRow> & { id: string } = {
    id: sdrId,
    reviewStatus: decision,
    reviewedBy: actorSub,
    reviewedAt: nowIso,
    reviewNote: note ?? undefined,
  };

  const updated = await deps.client.models.Sdr.update(patch);
  if (updated.errors) {
    throw new Error(
      `reviewSdr: Sdr.update returned errors: ${JSON.stringify(updated.errors)}`,
    );
  }
  const after = updated.data ?? { ...before, ...patch };

  await deps.audit(auditContextFrom(event), {
    action: 'SDR_REVIEW',
    targetType: 'Sdr',
    targetId: sdrId,
    before: snapshot(before),
    after: snapshot(after),
  });

  return after;
}

export const handler: AppSyncResolverHandler<Record<string, unknown>, SdrRow | null> = async (
  event,
  _context,
  _callback,
) => {
  const client = injected.dataClient ?? (await getDefaultClient());
  const auditFn: AuditFn = injected.audit ?? ((ctx, opts) => defaultAudit(ctx, opts));
  const now = injected.now ?? (() => new Date());
  const deps = { client, audit: auditFn, now };

  const field = (event as unknown as { fieldName?: string }).fieldName ?? event.info?.fieldName;
  switch (field) {
    case 'submitPublicSdr':
      return dispatchSubmitPublicSdr(event, deps);
    case 'reviewSdr':
      return dispatchReviewSdr(event, deps);
    default:
      throw new Error(`sdrMutations: unsupported fieldName "${field}"`);
  }
};
