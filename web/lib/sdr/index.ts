'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * SDR data layer — member SDR registration and admin review (#785).
 *
 * Backend surface:
 *   - `Sdr` model — fields name, kind (OWNED/PUBLIC), url, latitude/longitude,
 *     locationGranularity, publicVisible, reviewStatus, submitterId, ownerId.
 *   - `submitPublicSdr` mutation — member submits a PUBLIC SDR for admin review.
 *   - `reviewSdr` mutation — admin approves/rejects a PUBLIC SDR submission.
 *
 * Auth notes:
 *   - Reads use resolveAuthMode (mirrors audit.ts pattern).
 *   - submitPublicSdr: userPool (authenticated members).
 *   - reviewSdr: userPool (admin-only, enforced server-side).
 *   - Owned SDR CRUD uses model-level owner auth (Amplify resolves from session).
 */

const USER_POOL = { authMode: 'userPool' as const };

export type SdrKind = 'OWNED' | 'PUBLIC';
export type SdrReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type LocationGranularity = 'EXACT' | 'CITY' | 'REGION';

export interface SdrRow {
  id: string;
  name: string;
  kind: SdrKind | null;
  url: string | null;
  latitude: number | null;
  longitude: number | null;
  locationGranularity: LocationGranularity | null;
  publicVisible: boolean;
  notes: string | null;
  reviewStatus: SdrReviewStatus | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  submitterId: string | null;
  ownerId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Input for creating/updating an OWNED SDR */
export interface OwnedSdrInput {
  name: string;
  latitude: number | null;
  longitude: number | null;
  locationGranularity: LocationGranularity | null;
  publicVisible: boolean;
  notes: string | null;
}

/** Input for submitting a PUBLIC SDR */
export interface PublicSdrInput {
  name: string;
  url: string;
  latitude: number | null;
  longitude: number | null;
  locationGranularity: LocationGranularity | null;
  notes: string | null;
}

/** Form values for the owned SDR form */
export interface OwnedSdrFormValues {
  name: string;
  latitude: string;
  longitude: string;
  locationGranularity: LocationGranularity | '';
  publicVisible: boolean;
  notes: string;
}

/** Form values for the public SDR submission form */
export interface PublicSdrFormValues {
  name: string;
  url: string;
  latitude: string;
  longitude: string;
  locationGranularity: LocationGranularity | '';
  notes: string;
}

export type OwnedSdrFieldErrors = Partial<Record<'name' | 'latitude' | 'longitude' | 'url', string>>;
export type PublicSdrFieldErrors = Partial<Record<'name' | 'url' | 'latitude' | 'longitude', string>>;

// ---- Raw types (AppSync client returns unknown-shaped objects) ----

type RawSdr = {
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
  createdAt?: string | null;
  updatedAt?: string | null;
};

type RawListResult = {
  data?: RawSdr[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

type RawSingleResult = {
  data?: RawSdr | null;
  errors?: { message: string }[] | null;
};

type RawCustomMutationResult = {
  data?: unknown;
  errors?: { message: string }[] | null;
};

function throwOnErrors(errors: { message: string }[] | null | undefined, op: string): void {
  if (errors && errors.length > 0) {
    throw new Error(`${op} failed: ${errors.map((e) => e.message).join('; ')}`);
  }
}

function normalizeKind(s: string | null | undefined): SdrKind | null {
  return s === 'OWNED' || s === 'PUBLIC' ? s : null;
}

function normalizeReviewStatus(s: string | null | undefined): SdrReviewStatus | null {
  return s === 'PENDING' || s === 'APPROVED' || s === 'REJECTED' ? s : null;
}

function normalizeGranularity(s: string | null | undefined): LocationGranularity | null {
  return s === 'EXACT' || s === 'CITY' || s === 'REGION' ? s : null;
}

export function toSdrRow(r: RawSdr): SdrRow {
  return {
    id: r.id,
    name: r.name ?? '',
    kind: normalizeKind(r.kind),
    url: r.url ?? null,
    latitude: typeof r.latitude === 'number' ? r.latitude : null,
    longitude: typeof r.longitude === 'number' ? r.longitude : null,
    locationGranularity: normalizeGranularity(r.locationGranularity),
    publicVisible: r.publicVisible !== false,
    notes: r.notes ?? null,
    reviewStatus: normalizeReviewStatus(r.reviewStatus),
    reviewedBy: r.reviewedBy ?? null,
    reviewedAt: r.reviewedAt ?? null,
    reviewNote: r.reviewNote ?? null,
    submitterId: r.submitterId ?? null,
    ownerId: r.ownerId ?? null,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  };
}

/* --------------------------------------------------------------------- *
 * Validation
 * --------------------------------------------------------------------- */

export function validateOwnedSdrInput(values: OwnedSdrFormValues): {
  errors: OwnedSdrFieldErrors;
  input: OwnedSdrInput | null;
} {
  const errors: OwnedSdrFieldErrors = {};

  const name = (values.name ?? '').trim();
  if (!name) errors.name = 'Name is required.';

  let latitude: number | null = null;
  if (values.latitude && values.latitude.trim()) {
    const n = parseFloat(values.latitude);
    if (!Number.isFinite(n) || n < -90 || n > 90) errors.latitude = 'Latitude must be between -90 and 90.';
    else latitude = n;
  }

  let longitude: number | null = null;
  if (values.longitude && values.longitude.trim()) {
    const n = parseFloat(values.longitude);
    if (!Number.isFinite(n) || n < -180 || n > 180) errors.longitude = 'Longitude must be between -180 and 180.';
    else longitude = n;
  }

  if (Object.keys(errors).length > 0) return { errors, input: null };

  return {
    errors: {},
    input: {
      name,
      latitude,
      longitude,
      locationGranularity: values.locationGranularity || null,
      publicVisible: values.publicVisible,
      notes: (values.notes ?? '').trim() || null,
    },
  };
}

export function validatePublicSdrInput(values: PublicSdrFormValues): {
  errors: PublicSdrFieldErrors;
  input: PublicSdrInput | null;
} {
  const errors: PublicSdrFieldErrors = {};

  const name = (values.name ?? '').trim();
  if (!name) errors.name = 'Name is required.';

  const url = (values.url ?? '').trim();
  if (!url) errors.url = 'URL is required.';

  let latitude: number | null = null;
  if (values.latitude && values.latitude.trim()) {
    const n = parseFloat(values.latitude);
    if (!Number.isFinite(n) || n < -90 || n > 90) errors.latitude = 'Latitude must be between -90 and 90.';
    else latitude = n;
  }

  let longitude: number | null = null;
  if (values.longitude && values.longitude.trim()) {
    const n = parseFloat(values.longitude);
    if (!Number.isFinite(n) || n < -180 || n > 180) errors.longitude = 'Longitude must be between -180 and 180.';
    else longitude = n;
  }

  if (Object.keys(errors).length > 0) return { errors, input: null };

  return {
    errors: {},
    input: {
      name,
      url,
      latitude,
      longitude,
      locationGranularity: values.locationGranularity || null,
      notes: (values.notes ?? '').trim() || null,
    },
  };
}

export const EMPTY_OWNED_FORM: OwnedSdrFormValues = {
  name: '',
  latitude: '',
  longitude: '',
  locationGranularity: '',
  publicVisible: false,
  notes: '',
};

export const EMPTY_PUBLIC_FORM: PublicSdrFormValues = {
  name: '',
  url: '',
  latitude: '',
  longitude: '',
  locationGranularity: '',
  notes: '',
};

/* --------------------------------------------------------------------- *
 * AppSync CRUD wrappers
 * --------------------------------------------------------------------- */

/**
 * List the caller's SDRs (both OWNED and PUBLIC submissions).
 *
 * Accepts `callerSub` (the Cognito sub from `useAuth()`) so we can filter
 * server-side rows to the caller's own entries. The Sdr model grants
 * `allow.authenticated().to(['read'])` (pre-existing), meaning a full
 * `Sdr.list` returns all rows to any signed-in user. Without the caller-sub
 * filter the member panel would expose other members' SDR names and
 * submitterIds. We filter client-side here; a server-side GSI query by
 * ownerId/submitterId is the right long-term fix but requires a Lambda.
 *
 * @param callerSub - Cognito sub of the signed-in user (from `useAuth().sub`).
 */
export async function listMySdrs(callerSub: string): Promise<SdrRow[]> {
  const client = getDataClient();
  const listFn = client.models.Sdr.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const authMode = await resolveAuthMode();
  const raw = await listFn({ authMode });
  throwOnErrors(raw.errors, 'listMySdrs');
  return (raw.data ?? [])
    .map(toSdrRow)
    // Only return rows owned by or submitted by this caller.
    .filter((r) => r.ownerId === callerSub || r.submitterId === callerSub)
    .sort((a, b) => {
      // Owned first, then public; within each kind sort by name
      if (a.kind !== b.kind) return (a.kind ?? '') < (b.kind ?? '') ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Create an OWNED SDR for the current member.
 */
export async function createOwnedSdr(input: OwnedSdrInput): Promise<SdrRow> {
  const client = getDataClient();
  const createFn = client.models.Sdr.create as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await createFn(
    {
      name: input.name,
      kind: 'OWNED',
      publicVisible: input.publicVisible,
      ...(input.latitude !== null ? { latitude: input.latitude } : {}),
      ...(input.longitude !== null ? { longitude: input.longitude } : {}),
      ...(input.locationGranularity ? { locationGranularity: input.locationGranularity } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    },
    USER_POOL,
  );
  throwOnErrors(raw.errors, 'createOwnedSdr');
  if (!raw.data) throw new Error('createOwnedSdr: empty response');
  return toSdrRow(raw.data);
}

/**
 * Update an OWNED SDR row (owner-only).
 */
export async function updateOwnedSdr(id: string, input: OwnedSdrInput): Promise<SdrRow> {
  const client = getDataClient();
  const updateFn = client.models.Sdr.update as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawSingleResult>;
  const raw = await updateFn(
    {
      id,
      name: input.name,
      publicVisible: input.publicVisible,
      latitude: input.latitude,
      longitude: input.longitude,
      locationGranularity: input.locationGranularity,
      notes: input.notes,
    },
    USER_POOL,
  );
  throwOnErrors(raw.errors, 'updateOwnedSdr');
  if (!raw.data) throw new Error('updateOwnedSdr: empty response');
  return toSdrRow(raw.data);
}

/**
 * Submit a PUBLIC SDR for admin review.
 * Uses the `submitPublicSdr` custom mutation (Lambda-backed).
 */
export async function submitPublicSdr(input: PublicSdrInput): Promise<SdrRow> {
  const client = getDataClient();
  const mutateFn = client.mutations.submitPublicSdr as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawCustomMutationResult>;
  const raw = await mutateFn(
    {
      name: input.name,
      url: input.url,
      ...(input.latitude !== null ? { latitude: input.latitude } : {}),
      ...(input.longitude !== null ? { longitude: input.longitude } : {}),
      ...(input.locationGranularity ? { locationGranularity: input.locationGranularity } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    },
    USER_POOL,
  );
  throwOnErrors(raw.errors, 'submitPublicSdr');
  if (!raw.data) throw new Error('submitPublicSdr: empty response');
  return toSdrRow(raw.data as RawSdr);
}

/**
 * Admin: approve or reject a PUBLIC SDR submission.
 * Uses the `reviewSdr` custom mutation (Lambda-backed).
 */
export async function reviewSdr(
  sdrId: string,
  decision: 'APPROVED' | 'REJECTED',
  note?: string,
): Promise<SdrRow> {
  const client = getDataClient();
  const mutateFn = client.mutations.reviewSdr as unknown as (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawCustomMutationResult>;
  const raw = await mutateFn(
    {
      sdrId,
      decision,
      ...(note ? { note } : {}),
    },
    USER_POOL,
  );
  throwOnErrors(raw.errors, 'reviewSdr');
  if (!raw.data) throw new Error('reviewSdr: empty response');
  return toSdrRow(raw.data as RawSdr);
}

/**
 * List all PUBLIC SDRs in PENDING status (for admin review queue).
 */
export async function listPendingPublicSdrs(): Promise<SdrRow[]> {
  // We list all and filter client-side. The model's `submitterId` GSI
  // doesn't filter on kind+reviewStatus; a real implementation would use
  // a GSI or scan with FilterExpression at the Lambda layer. For v1 (small
  // table), client-side filter is acceptable.
  const client = getDataClient();
  const listFn = client.models.Sdr.list as unknown as (
    input?: Record<string, unknown>,
  ) => Promise<RawListResult>;
  const raw = await listFn({ authMode: 'userPool' });
  throwOnErrors(raw.errors, 'listPendingPublicSdrs');
  return (raw.data ?? [])
    .map(toSdrRow)
    .filter((r) => r.kind === 'PUBLIC' && r.reviewStatus === 'PENDING')
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}
