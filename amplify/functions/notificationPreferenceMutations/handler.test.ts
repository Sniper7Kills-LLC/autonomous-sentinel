import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppSyncResolverEvent, Context } from 'aws-lambda';
import {
  handler,
  __setDeps,
  __resetDeps,
  type NotificationPrefDeps,
  type NotificationPreferenceRow,
  type NotificationPreferenceView,
  type SetNotificationPreferenceInput,
  type GetNotificationPreferenceArgs,
} from './handler';

/**
 * Tests for `notificationPreferenceMutations` (#288).
 *
 * Covers:
 *   - set: discordWebhookUrl plaintext is KMS-encrypted before storage;
 *   - set: caller can only ever target their own sub (no userId arg);
 *   - set: null/empty plaintext clears the stored ciphertext;
 *   - set: untouched fields stay untouched (patch shape);
 *   - get: owner sees decrypted plaintext URL;
 *   - get: admin reading another user's row also sees decrypted URL;
 *   - get: non-admin attempting cross-user read is rejected;
 *   - get: missing row + owner caller → lazy-create default row;
 *   - get: missing row + admin reading another user → null (no provision);
 *   - get: ciphertext never returned in plaintext to non-owner / non-admin
 *     (admin-bypass is the only cross-user path; verify the guard).
 *   - identity guards: missing sub is rejected.
 */

function fullIdentity(
  partial: { sub?: string | null; groups?: string[] | null } | null,
): AppSyncResolverEvent<Record<string, never>>['identity'] {
  if (partial === null) return null;
  return {
    sub: partial.sub ?? 'unset-sub',
    issuer: 'https://cognito',
    username: 'test-user',
    claims: {},
    sourceIp: ['203.0.113.1'],
    defaultAuthStrategy: 'ALLOW',
    groups: partial.groups ?? null,
  };
}

function setEvent(
  args: SetNotificationPreferenceInput,
  identity: { sub?: string | null; groups?: string[] | null } | null = null,
): AppSyncResolverEvent<SetNotificationPreferenceInput> {
  return {
    arguments: args,
    identity: fullIdentity(identity),
    source: null,
    request: { headers: {}, domainName: null },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Mutation',
      fieldName: 'setNotificationPreference',
      variables: {},
    },
    prev: null,
    stash: {},
  };
}

function getEvent(
  args: GetNotificationPreferenceArgs,
  identity: { sub?: string | null; groups?: string[] | null } | null = null,
): AppSyncResolverEvent<GetNotificationPreferenceArgs> {
  return {
    arguments: args,
    identity: fullIdentity(identity),
    source: null,
    request: { headers: {}, domainName: null },
    info: {
      selectionSetList: [],
      selectionSetGraphQL: '',
      parentTypeName: 'Query',
      fieldName: 'getNotificationPreference',
      variables: {},
    },
    prev: null,
    stash: {},
  };
}

interface Stubs extends NotificationPrefDeps {
  getSpy: ReturnType<typeof vi.fn>;
  updateSpy: ReturnType<typeof vi.fn>;
  encryptSpy: ReturnType<typeof vi.fn>;
  decryptSpy: ReturnType<typeof vi.fn>;
  rows: Map<string, NotificationPreferenceRow>;
}

function makeStubs(initial: Iterable<NotificationPreferenceRow> = []): Stubs {
  const rows = new Map<string, NotificationPreferenceRow>();
  for (const r of initial) rows.set(r.userId, r);

  const getSpy = vi.fn((userId: string) => Promise.resolve(rows.get(userId) ?? null));
  const updateSpy = vi.fn((userId: string, patch: Partial<NotificationPreferenceRow>) => {
    const prior = rows.get(userId) ?? { userId };
    const merged: NotificationPreferenceRow = { ...prior, ...patch, userId };
    rows.set(userId, merged);
    return Promise.resolve(merged);
  });

  // Reversible stub: "CIPHER:<plaintext>" — lets the round-trip assertion
  // verify both sides of the KMS boundary without touching real KMS.
  const encryptSpy = vi.fn((plaintext: string) =>
    Promise.resolve(Buffer.from(`CIPHER:${plaintext}`).toString('base64')),
  );
  const decryptSpy = vi.fn((b64: string) => {
    const s = Buffer.from(b64, 'base64').toString('utf8');
    if (!s.startsWith('CIPHER:')) {
      return Promise.reject(new Error(`decrypt stub: not stub ciphertext: ${s}`));
    }
    return Promise.resolve(s.slice('CIPHER:'.length));
  });

  return {
    rows,
    getSpy,
    updateSpy,
    encryptSpy,
    decryptSpy,
    getRow: getSpy,
    updateRow: updateSpy,
    encrypt: encryptSpy,
    decrypt: decryptSpy,
  };
}

describe('setNotificationPreference', () => {
  beforeEach(() => __resetDeps());

  it('encrypts plaintext discordWebhookUrl via KMS before storing', async () => {
    const stubs = makeStubs();
    __setDeps(stubs);
    const event = setEvent(
      { discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc' },
      { sub: 'user-1' },
    );
    await handler(event, {} as Context, () => undefined);
    expect(stubs.encryptSpy).toHaveBeenCalledOnce();
    expect(stubs.encryptSpy).toHaveBeenCalledWith('https://discord.com/api/webhooks/123/abc');

    const stored = stubs.rows.get('user-1');
    expect(stored).toBeDefined();
    expect(stored?.discordWebhookUrlEnc).toBe(
      Buffer.from('CIPHER:https://discord.com/api/webhooks/123/abc').toString('base64'),
    );
  });

  it('returns the just-set plaintext URL in the response (owner roundtrip)', async () => {
    const stubs = makeStubs();
    __setDeps(stubs);
    const event = setEvent(
      { discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc' },
      { sub: 'user-1' },
    );
    const result = (await handler(
      event,
      {} as Context,
      () => undefined,
    )) as NotificationPreferenceView;
    expect(result.discordWebhookUrl).toBe('https://discord.com/api/webhooks/123/abc');
    expect(result.userId).toBe('user-1');
  });

  it('clears the stored ciphertext when caller passes discordWebhookUrl: null', async () => {
    const stubs = makeStubs([
      {
        userId: 'user-2',
        discordWebhookUrlEnc: Buffer.from('CIPHER:existing').toString('base64'),
      },
    ]);
    __setDeps(stubs);
    const event = setEvent({ discordWebhookUrl: null }, { sub: 'user-2' });
    const result = (await handler(
      event,
      {} as Context,
      () => undefined,
    )) as NotificationPreferenceView;
    expect(stubs.rows.get('user-2')?.discordWebhookUrlEnc).toBeNull();
    expect(result.discordWebhookUrl).toBeNull();
    expect(stubs.encryptSpy).not.toHaveBeenCalled();
  });

  it('clears the stored ciphertext when caller passes empty string', async () => {
    const stubs = makeStubs([
      {
        userId: 'user-3',
        discordWebhookUrlEnc: Buffer.from('CIPHER:old').toString('base64'),
      },
    ]);
    __setDeps(stubs);
    const event = setEvent({ discordWebhookUrl: '' }, { sub: 'user-3' });
    await handler(event, {} as Context, () => undefined);
    expect(stubs.rows.get('user-3')?.discordWebhookUrlEnc).toBeNull();
  });

  it('pins the target row to identity.sub (no privilege-escalation arg)', async () => {
    // The mutation has no userId argument. Even if a malicious client
    // injects one onto the JSON body, the handler must ignore it and
    // write to the caller's own sub.
    const stubs = makeStubs();
    __setDeps(stubs);
    const evilArgs = {
      discordWebhookUrl: 'https://evil',
      userId: 'victim-sub',
    } as unknown as SetNotificationPreferenceInput;
    const event = setEvent(evilArgs, { sub: 'attacker-sub' });
    await handler(event, {} as Context, () => undefined);
    expect(stubs.rows.has('victim-sub')).toBe(false);
    expect(stubs.rows.has('attacker-sub')).toBe(true);
  });

  it('only touches the fields the caller provided (untouched fields stay)', async () => {
    const stubs = makeStubs([
      {
        userId: 'user-4',
        emailEnabled: true,
        pushEnabled: false,
        discordWebhookEnabled: true,
        discordWebhookUrlEnc: Buffer.from('CIPHER:keep-me').toString('base64'),
        weeklyDigest: true,
      },
    ]);
    __setDeps(stubs);
    const event = setEvent({ pushEnabled: true }, { sub: 'user-4' });
    await handler(event, {} as Context, () => undefined);
    // The update stub merges patch onto prior row; verify the patch
    // shape only carried the one column the caller touched.
    expect(stubs.updateSpy).toHaveBeenCalledWith('user-4', { pushEnabled: true });
    const stored = stubs.rows.get('user-4');
    expect(stored?.emailEnabled).toBe(true);
    expect(stored?.discordWebhookEnabled).toBe(true);
    expect(stored?.discordWebhookUrlEnc).toBe(Buffer.from('CIPHER:keep-me').toString('base64'));
    expect(stored?.weeklyDigest).toBe(true);
  });

  it('rejects when caller has no identity sub', async () => {
    __setDeps(makeStubs());
    const event = setEvent({ emailEnabled: true }, null);
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not signed in/);
  });
});

describe('getNotificationPreference', () => {
  beforeEach(() => __resetDeps());

  it('owner sees decrypted plaintext discordWebhookUrl', async () => {
    const stubs = makeStubs([
      {
        userId: 'user-1',
        emailEnabled: true,
        discordWebhookEnabled: true,
        discordWebhookUrlEnc: Buffer.from('CIPHER:https://hook').toString('base64'),
      },
    ]);
    __setDeps(stubs);
    const event = getEvent({}, { sub: 'user-1' });
    const result = (await handler(
      event,
      {} as Context,
      () => undefined,
    )) as NotificationPreferenceView;
    expect(result.discordWebhookUrl).toBe('https://hook');
    expect(result.emailEnabled).toBe(true);
    expect(result.discordWebhookEnabled).toBe(true);
    expect(stubs.decryptSpy).toHaveBeenCalledOnce();
  });

  it('admin reading another user sees decrypted plaintext URL', async () => {
    const stubs = makeStubs([
      {
        userId: 'victim',
        discordWebhookUrlEnc: Buffer.from('CIPHER:https://victim-hook').toString('base64'),
      },
    ]);
    __setDeps(stubs);
    const event = getEvent({ userId: 'victim' }, { sub: 'admin-1', groups: ['admin'] });
    const result = (await handler(
      event,
      {} as Context,
      () => undefined,
    )) as NotificationPreferenceView;
    expect(result.discordWebhookUrl).toBe('https://victim-hook');
  });

  it('rejects non-admin attempting to read another user', async () => {
    const stubs = makeStubs([
      {
        userId: 'victim',
        discordWebhookUrlEnc: Buffer.from('CIPHER:https://victim-hook').toString('base64'),
      },
    ]);
    __setDeps(stubs);
    const event = getEvent({ userId: 'victim' }, { sub: 'snoop', groups: ['member'] });
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/admin group/);
    expect(stubs.decryptSpy).not.toHaveBeenCalled();
  });

  it('returns the row with null URL when stored ciphertext is missing', async () => {
    const stubs = makeStubs([
      {
        userId: 'user-no-url',
        emailEnabled: true,
        discordWebhookEnabled: false,
        discordWebhookUrlEnc: null,
      },
    ]);
    __setDeps(stubs);
    const event = getEvent({}, { sub: 'user-no-url' });
    const result = (await handler(
      event,
      {} as Context,
      () => undefined,
    )) as NotificationPreferenceView;
    expect(result.discordWebhookUrl).toBeNull();
    expect(stubs.decryptSpy).not.toHaveBeenCalled();
  });

  it('lazy-creates a default row on first owner read', async () => {
    const stubs = makeStubs();
    __setDeps(stubs);
    const event = getEvent({}, { sub: 'fresh-user' });
    const result = (await handler(
      event,
      {} as Context,
      () => undefined,
    )) as NotificationPreferenceView;
    expect(result.userId).toBe('fresh-user');
    expect(result.emailEnabled).toBe(false);
    expect(result.pushEnabled).toBe(false);
    expect(result.discordWebhookEnabled).toBe(false);
    expect(result.discordWebhookUrl).toBeNull();
    expect(result.weeklyDigest).toBe(false);
    expect(stubs.rows.has('fresh-user')).toBe(true);
    expect(stubs.updateSpy).toHaveBeenCalledOnce();
  });

  it('admin reading another user that does not exist returns null (no auto-provision)', async () => {
    const stubs = makeStubs();
    __setDeps(stubs);
    const event = getEvent({ userId: 'never-existed' }, { sub: 'admin-1', groups: ['admin'] });
    const result = await handler(event, {} as Context, () => undefined);
    expect(result).toBeNull();
    expect(stubs.rows.has('never-existed')).toBe(false);
    expect(stubs.updateSpy).not.toHaveBeenCalled();
  });

  it('treats explicit userId equal to caller sub the same as omitted', async () => {
    const stubs = makeStubs([
      {
        userId: 'self',
        emailEnabled: true,
        discordWebhookUrlEnc: Buffer.from('CIPHER:https://my').toString('base64'),
      },
    ]);
    __setDeps(stubs);
    const event = getEvent({ userId: 'self' }, { sub: 'self', groups: ['member'] });
    const result = (await handler(
      event,
      {} as Context,
      () => undefined,
    )) as NotificationPreferenceView;
    expect(result.discordWebhookUrl).toBe('https://my');
  });

  it('rejects when caller has no identity sub (guest)', async () => {
    __setDeps(makeStubs());
    const event = getEvent({}, null);
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(/not signed in/);
  });
});

describe('handler dispatch', () => {
  beforeEach(() => __resetDeps());

  it('rejects an unknown fieldName', async () => {
    __setDeps(makeStubs());
    const event = getEvent({}, { sub: 'user-1' });
    (event.info as { fieldName: string }).fieldName = 'mysteryField';
    await expect(handler(event, {} as Context, () => undefined)).rejects.toThrow(
      /unsupported fieldName/,
    );
  });
});
