import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  audit,
  AUDIT_ACTIONS,
  diffShallow,
  type AuditContext,
  type AuditDataClient,
} from './audit-log-helper';

/**
 * Fake Amplify Data client surface: only the AuditLog.create entry point.
 *
 * The real Amplify client returns `{ data, errors }`. We mirror that shape
 * so production code paths exercise the same destructuring.
 */
function makeFakeClient(opts: { id?: string; errors?: unknown[] } = {}): {
  client: AuditDataClient;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn().mockImplementation(() =>
    Promise.resolve({
      data: { id: opts.id ?? 'audit-id-1' },
      errors: opts.errors,
    }),
  );
  const client: AuditDataClient = {
    models: {
      AuditLog: {
        create: createSpy,
      },
    },
  };
  return { client, createSpy };
}

function makeCtx(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    identity: { sub: 'cognito-sub-actor-123' },
    request: {
      headers: {
        'x-forwarded-for': '203.0.113.45',
        'user-agent': 'TestAgent/1.0',
      },
    },
    ...overrides,
  };
}

describe('audit helper', () => {
  let fake: ReturnType<typeof makeFakeClient>;

  beforeEach(() => {
    fake = makeFakeClient();
  });

  it('writes a row with actor identity pulled from ctx.identity.sub', async () => {
    await audit(
      makeCtx(),
      {
        action: 'MESSAGE_DELETE',
        targetType: 'Message',
        targetId: 'msg-1',
      },
      { client: fake.client },
    );

    expect(fake.createSpy).toHaveBeenCalledOnce();
    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.actorId).toBe('cognito-sub-actor-123');
    expect(input.action).toBe('MESSAGE_DELETE');
    expect(input.targetType).toBe('Message');
    expect(input.targetId).toBe('msg-1');
  });

  it('treats unauthenticated ctx (no identity) as a system-emitted entry (actorId null)', async () => {
    await audit(
      { request: { headers: {} } },
      {
        action: 'OTHER',
        targetType: 'Message',
        targetId: 'msg-system',
      },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.actorId).toBeNull();
  });

  it('returns the created entry id from the data client response', async () => {
    fake = makeFakeClient({ id: 'audit-abc-123' });

    const id = await audit(
      makeCtx(),
      {
        action: 'MESSAGE_DELETE',
        targetType: 'Message',
        targetId: 'msg-1',
      },
      { client: fake.client },
    );

    expect(id).toBe('audit-abc-123');
  });

  it('rejects when both targetType and targetId are missing', async () => {
    // Deliberately bypass the type system to exercise the runtime guard.
    const bad = { action: 'OTHER' } as unknown as Parameters<typeof audit>[1];
    await expect(audit(makeCtx(), bad, { client: fake.client })).rejects.toThrow(/target/i);
    expect(fake.createSpy).not.toHaveBeenCalled();
  });

  it('rejects when targetType is set but targetId is missing', async () => {
    const bad = {
      action: 'OTHER',
      targetType: 'Message',
    } as unknown as Parameters<typeof audit>[1];
    await expect(audit(makeCtx(), bad, { client: fake.client })).rejects.toThrow(/target/i);
  });

  it('rejects when targetId is set but targetType is missing', async () => {
    const bad = {
      action: 'OTHER',
      targetId: 'msg-1',
    } as unknown as Parameters<typeof audit>[1];
    await expect(audit(makeCtx(), bad, { client: fake.client })).rejects.toThrow(/target/i);
  });

  it('captures ipAddress from the first hop of x-forwarded-for', async () => {
    await audit(
      makeCtx({
        request: {
          headers: {
            'x-forwarded-for': '198.51.100.7, 10.0.0.1, 10.0.0.2',
            'user-agent': 'X',
          },
        },
      }),
      { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.ipAddress).toBe('198.51.100.7');
  });

  it('trims surrounding whitespace around the first hop', async () => {
    await audit(
      makeCtx({
        request: {
          headers: {
            'x-forwarded-for': '  203.0.113.99  , 10.0.0.1',
            'user-agent': 'X',
          },
        },
      }),
      { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.ipAddress).toBe('203.0.113.99');
  });

  it('captures userAgent from the user-agent header', async () => {
    await audit(
      makeCtx({
        request: {
          headers: {
            'x-forwarded-for': '1.2.3.4',
            'user-agent': 'Mozilla/5.0 (Audit Test)',
          },
        },
      }),
      { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.userAgent).toBe('Mozilla/5.0 (Audit Test)');
  });

  it('leaves ipAddress / userAgent null when the corresponding header is missing', async () => {
    await audit(
      { identity: { sub: 'actor' }, request: { headers: {} } },
      { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.ipAddress).toBeNull();
    expect(input.userAgent).toBeNull();
  });

  it('survives a missing request object entirely', async () => {
    await audit(
      { identity: { sub: 'actor' } },
      { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.ipAddress).toBeNull();
    expect(input.userAgent).toBeNull();
  });

  it('stores the supplied reason on the row', async () => {
    await audit(
      makeCtx(),
      {
        action: 'USER_BAN',
        targetType: 'User',
        targetId: 'user-42',
        reason: 'Spam, repeated abuse reports',
      },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.reason).toBe('Spam, repeated abuse reports');
  });

  it('threads targetMessageId through when the target is a Message', async () => {
    await audit(
      makeCtx(),
      {
        action: 'MESSAGE_DELETE',
        targetType: 'Message',
        targetId: 'msg-1',
      },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.targetMessageId).toBe('msg-1');
  });

  it('does not set targetMessageId when the target is some other type', async () => {
    await audit(
      makeCtx(),
      {
        action: 'USER_BAN',
        targetType: 'User',
        targetId: 'user-42',
      },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.targetMessageId).toBeNull();
  });

  it('throws if the data client returns errors', async () => {
    fake = makeFakeClient({ errors: [{ message: 'Access denied' }] });

    await expect(
      audit(
        makeCtx(),
        { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
        { client: fake.client },
      ),
    ).rejects.toThrow(/audit.*log.*create/i);
  });

  it('throws if the data client returns no id', async () => {
    const createSpy = vi.fn().mockResolvedValue({ data: null, errors: undefined });
    const brokenClient: AuditDataClient = {
      models: {
        AuditLog: {
          create: createSpy,
        },
      },
    };

    await expect(
      audit(
        makeCtx(),
        { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
        { client: brokenClient },
      ),
    ).rejects.toThrow(/audit.*log/i);
  });
});

describe('audit helper — diff computation', () => {
  it('emits per-key { before, after } for keys that differ', () => {
    const d = diffShallow({ a: 1, b: 'old', c: true }, { a: 1, b: 'new', c: false });
    expect(d).toEqual({
      b: { before: 'old', after: 'new' },
      c: { before: true, after: false },
    });
  });

  it('records keys added on the after side', () => {
    const d = diffShallow({ a: 1 }, { a: 1, b: 2 });
    expect(d).toEqual({ b: { before: undefined, after: 2 } });
  });

  it('records keys removed on the after side', () => {
    const d = diffShallow({ a: 1, b: 2 }, { a: 1 });
    expect(d).toEqual({ b: { before: 2, after: undefined } });
  });

  it('returns an empty object when nothing changed', () => {
    expect(diffShallow({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('treats null and undefined separately from each other', () => {
    expect(diffShallow({ a: null }, { a: undefined })).toEqual({
      a: { before: null, after: undefined },
    });
  });

  it('writes the diff to the AuditLog row when before+after are supplied', async () => {
    const fake = makeFakeClient();
    await audit(
      makeCtx(),
      {
        action: 'MESSAGE_EDIT',
        targetType: 'Message',
        targetId: 'msg-1',
        before: { sender: 'A', body: 'old' },
        after: { sender: 'A', body: 'new' },
      },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.diff).toEqual({
      body: { before: 'old', after: 'new' },
    });
  });

  it('writes a null diff when neither before nor after is supplied', async () => {
    const fake = makeFakeClient();
    await audit(
      makeCtx(),
      { action: 'OTHER', targetType: 'Message', targetId: 'msg-1' },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.diff).toBeNull();
  });

  it('writes a diff even when only one side is supplied', async () => {
    const fake = makeFakeClient();
    await audit(
      makeCtx(),
      {
        action: 'TRANSMITTER_CREATE',
        targetType: 'Transmitter',
        targetId: 'tx-1',
        after: { name: 'NEW', siteId: 'X' },
      },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.diff).toEqual({
      name: { before: undefined, after: 'NEW' },
      siteId: { before: undefined, after: 'X' },
    });
  });
});

describe('audit helper — every action enum value works', () => {
  // Parametrized smoke test: every one of the 19 enum values is accepted by
  // the helper and round-trips into the AuditLog.create call.
  it.each(AUDIT_ACTIONS)('action %s round-trips into the AuditLog row', async (action) => {
    const fake = makeFakeClient();
    await audit(
      { identity: { sub: 'actor' }, request: { headers: {} } },
      { action, targetType: 'Whatever', targetId: 'whatever-1' },
      { client: fake.client },
    );

    const input = fake.createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.action).toBe(action);
  });

  it('exports exactly the enum values defined on the AuditLog model', () => {
    // The #258 issue body referred to "19 enum values"; ships 25 after
    // #272 (USER_CLAIM) + #273 (USER_CLAIM_FANOUT) + #270
    // (FIELDVOTE_ORPHAN_SWEEP) + #286 (SDR_PII_BLANK) + #285
    // (MESSAGE_SUBMIT_RECORDINGLESS). Source of truth is
    // `amplify/data/models/audit-log.ts`.
    expect(AUDIT_ACTIONS).toHaveLength(25);
    expect(new Set(AUDIT_ACTIONS).size).toBe(25);
  });

  it('exports every value defined on the AuditLog.action enum', () => {
    // Hard-coded against models/audit-log.ts. If the model adds an action,
    // this test forces the helper to add it too.
    expect(new Set(AUDIT_ACTIONS)).toEqual(
      new Set([
        'MESSAGE_DELETE',
        'MESSAGE_RESTORE',
        'MESSAGE_EDIT',
        'MESSAGE_SUBMIT_RECORDINGLESS',
        'RECORDING_DELETE',
        'RECORDING_RESTORE',
        'COMMENT_DELETE',
        'USER_BAN',
        'USER_UNBAN',
        'USER_ROLE_CHANGE',
        'USER_PII_BLANK',
        'USER_CLAIM',
        'USER_CLAIM_FANOUT',
        'SDR_PII_BLANK',
        'FIELDVOTE_ORPHAN_SWEEP',
        'TRANSMITTER_CREATE',
        'TRANSMITTER_UPDATE',
        'TRANSMITTER_DELETE',
        'CALLSIGN_MERGE',
        'LINGUISTIC_CONFIG_UPDATE',
        'BAN_REGION_PAGE_UPDATE',
        'PROMPT_VERSION_BUMP',
        'BUDGET_THRESHOLD_UPDATE',
        'REP_FORMULA_UPDATE',
        'OTHER',
      ]),
    );
  });
});
