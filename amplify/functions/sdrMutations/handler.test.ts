import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type SdrMutationsDataClient,
  type SdrRow,
} from './handler';

/**
 * Lambda-resolver tests for `submitPublicSdr` and `reviewSdr` (#785).
 * Mirrors the messageMutations handler.test.ts shape.
 */

function makeEvent(
  overrides: Partial<AppSyncResolverEvent<Record<string, unknown>>> & {
    fieldName?: string;
  } = {},
): AppSyncResolverEvent<Record<string, unknown>> {
  const { fieldName = 'submitPublicSdr', ...rest } = overrides;
  const base: AppSyncResolverEvent<Record<string, unknown>> = {
    arguments: {},
    identity: {
      sub: 'cog-member-001',
      issuer: 'https://cognito',
      username: 'member',
      claims: {},
      sourceIp: ['203.0.113.1'],
      defaultAuthStrategy: 'ALLOW',
      groups: ['member'],
    },
    source: null,
    request: {
      headers: { 'x-forwarded-for': '203.0.113.1', 'user-agent': 'TestAgent/1.0' },
      domainName: null,
    },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Mutation',
      fieldName,
      variables: {},
    },
    prev: null,
    stash: {},
  };
  return { ...base, ...rest };
}

interface MakeStubsResult {
  client: SdrMutationsDataClient;
  getSpy: ReturnType<typeof vi.fn>;
  createSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  auditSpy: Mock<() => Promise<string>>;
  sdrs: Map<string, SdrRow>;
}

function makeStubs(opts: { existingSdr?: SdrRow | null } = {}): MakeStubsResult {
  const sdrs = new Map<string, SdrRow>();
  if (opts.existingSdr) {
    sdrs.set(opts.existingSdr.id, opts.existingSdr);
  }

  const getSpy = vi.fn((input: { id: string }) => {
    const row = sdrs.get(input.id) ?? null;
    return Promise.resolve({ data: row });
  });

  const createSpy = vi.fn((input: Partial<SdrRow>) => {
    const row: SdrRow = { id: 'sdr-created-001', ...input };
    sdrs.set(row.id, row);
    return Promise.resolve({ data: row });
  });

  const updateSpy = vi.fn((input: Partial<SdrRow> & { id: string }) => {
    const existing = sdrs.get(input.id);
    if (!existing) return Promise.resolve({ data: null, errors: [{ message: 'not found' }] });
    const updated = { ...existing, ...input };
    sdrs.set(input.id, updated);
    return Promise.resolve({ data: updated });
  });

  const auditSpy: Mock<() => Promise<string>> = vi.fn(() => Promise.resolve('audit-id-001'));

  const client: SdrMutationsDataClient = {
    models: {
      Sdr: { get: getSpy, create: createSpy, update: updateSpy },
    },
  };

  return { client, getSpy, createSpy, updateSpy, auditSpy, sdrs };
}

describe('sdrMutations handler — submitPublicSdr', () => {
  beforeEach(() => {
    __resetDeps();
  });

  it('creates a PUBLIC SDR with PENDING status and writes audit', async () => {
    const { client, createSpy, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy, now: () => new Date('2025-01-01T00:00:00Z') });

    const event = makeEvent({
      arguments: {
        name: 'KiwiSDR Tokyo',
        url: 'http://example.com:8073',
        latitude: 35.6895,
        longitude: 139.6917,
        locationGranularity: 'CITY',
        notes: 'Test notes',
      },
    });

    const result = await handler(
      event,
      {} as Context,
      () => {},
    );

    expect(result).not.toBeNull();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'KiwiSDR Tokyo',
        url: 'http://example.com:8073',
        kind: 'PUBLIC',
        reviewStatus: 'PENDING',
        submitterId: 'cog-member-001',
        publicVisible: false,
        latitude: 35.6895,
        longitude: 139.6917,
        locationGranularity: 'CITY',
        notes: 'Test notes',
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ identity: { sub: 'cog-member-001' } }),
      expect.objectContaining({ action: 'SDR_SUBMIT_PUBLIC', targetType: 'Sdr' }),
    );
  });

  it('rejects blank name', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeEvent({
      arguments: { name: '  ', url: 'http://example.com:8073' },
    });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'submitPublicSdr: name argument is required',
    );
  });

  it('rejects blank url', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeEvent({
      arguments: { name: 'My SDR', url: '' },
    });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'submitPublicSdr: url argument is required',
    );
  });

  it('rejects unauthenticated caller (no sub)', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeEvent({
      identity: null,
      arguments: { name: 'Test SDR', url: 'http://example.com:8073' },
    } as Partial<AppSyncResolverEvent<Record<string, unknown>>> & { fieldName?: string });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'submitPublicSdr: caller has no identity',
    );
  });

  it('ignores invalid locationGranularity (does not include it in create)', async () => {
    const { client, createSpy, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeEvent({
      arguments: {
        name: 'Test SDR',
        url: 'http://example.com:8073',
        locationGranularity: 'INVALID',
      },
    });

    await handler(event, {} as Context, () => {});

    expect(createSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ locationGranularity: 'INVALID' }),
    );
  });

  it('continues even if audit write fails', async () => {
    const { client, createSpy } = makeStubs();
    const failingAudit = vi.fn(() => Promise.reject(new Error('audit down')));
    __setDeps({ dataClient: client, audit: failingAudit });

    const event = makeEvent({
      arguments: { name: 'Test SDR', url: 'http://example.com:8073' },
    });

    const result = await handler(event, {} as Context, () => {});
    expect(result).not.toBeNull();
    expect(createSpy).toHaveBeenCalled();
  });

  it('throws unsupported fieldName', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeEvent({ fieldName: 'unknownMutation' });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'sdrMutations: unsupported fieldName',
    );
  });
});

describe('sdrMutations handler — reviewSdr', () => {
  beforeEach(() => {
    __resetDeps();
  });

  const pendingSdr: SdrRow = {
    id: 'sdr-public-001',
    name: 'KiwiSDR London',
    kind: 'PUBLIC',
    reviewStatus: 'PENDING',
    submitterId: 'cog-member-001',
    publicVisible: false,
  };

  function makeAdminEvent(
    overrides: Partial<AppSyncResolverEvent<Record<string, unknown>>> = {},
  ): AppSyncResolverEvent<Record<string, unknown>> {
    return makeEvent({
      fieldName: 'reviewSdr',
      identity: {
        sub: 'cog-admin-001',
        issuer: 'https://cognito',
        username: 'admin',
        claims: {},
        sourceIp: ['203.0.113.1'],
        defaultAuthStrategy: 'ALLOW',
        groups: ['admin'],
      },
      ...overrides,
    });
  }

  it('approves a PENDING SDR and writes audit', async () => {
    const { client, updateSpy, auditSpy } = makeStubs({ existingSdr: pendingSdr });
    __setDeps({ dataClient: client, audit: auditSpy, now: () => new Date('2025-06-01T12:00:00Z') });

    const event = makeAdminEvent({
      arguments: { sdrId: 'sdr-public-001', decision: 'APPROVED', note: 'Looks good' },
    });

    const result = (await handler(event, {} as Context, () => {})) as SdrRow;

    expect(result?.reviewStatus).toBe('APPROVED');
    expect(result?.reviewedBy).toBe('cog-admin-001');
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sdr-public-001',
        reviewStatus: 'APPROVED',
        reviewedBy: 'cog-admin-001',
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'SDR_REVIEW', targetType: 'Sdr', targetId: 'sdr-public-001' }),
    );
  });

  it('rejects a PENDING SDR', async () => {
    const { client, updateSpy, auditSpy } = makeStubs({ existingSdr: pendingSdr });
    __setDeps({ dataClient: client, audit: auditSpy, now: () => new Date('2025-06-01T12:00:00Z') });

    const event = makeAdminEvent({
      arguments: { sdrId: 'sdr-public-001', decision: 'REJECTED', note: 'Fake URL' },
    });

    const result = (await handler(event, {} as Context, () => {})) as SdrRow;

    expect(result?.reviewStatus).toBe('REJECTED');
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sdr-public-001', reviewStatus: 'REJECTED' }),
    );
  });

  it('throws for non-admin caller', async () => {
    const { client, auditSpy } = makeStubs({ existingSdr: pendingSdr });
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeEvent({
      fieldName: 'reviewSdr',
      arguments: { sdrId: 'sdr-public-001', decision: 'APPROVED' },
    });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'reviewSdr: caller is not in the admin group',
    );
  });

  it('throws for invalid decision value', async () => {
    const { client, auditSpy } = makeStubs({ existingSdr: pendingSdr });
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeAdminEvent({
      arguments: { sdrId: 'sdr-public-001', decision: 'MAYBE' },
    });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'reviewSdr: decision must be APPROVED or REJECTED',
    );
  });

  it('throws when SDR row not found', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeAdminEvent({
      arguments: { sdrId: 'sdr-nonexistent', decision: 'APPROVED' },
    });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'reviewSdr: Sdr row not found',
    );
  });

  it('throws when sdrId is blank', async () => {
    const { client, auditSpy } = makeStubs();
    __setDeps({ dataClient: client, audit: auditSpy });

    const event = makeAdminEvent({
      arguments: { sdrId: '', decision: 'APPROVED' },
    });

    await expect(handler(event, {} as Context, () => {})).rejects.toThrow(
      'reviewSdr: sdrId argument is required',
    );
  });
});
