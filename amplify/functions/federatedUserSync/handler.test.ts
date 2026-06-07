import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { handler, parseJob, __setStore } from './handler';
import type { FederatedUserStore } from './ensure';

function sqsEvent(bodies: string[]): SQSEvent {
  return {
    Records: bodies.map((body, i) => ({ messageId: String(i), body })),
  } as unknown as SQSEvent;
}

describe('parseJob (#783)', () => {
  it('parses a valid job', () => {
    expect(parseJob(JSON.stringify({ cognitoSub: 's', email: 'a@b.c', displayName: 'N' }))).toEqual(
      {
        cognitoSub: 's',
        email: 'a@b.c',
        displayName: 'N',
        preferredUsername: null,
      },
    );
  });
  it('returns null for malformed JSON / missing sub', () => {
    expect(parseJob('not json')).toBeNull();
    expect(parseJob(JSON.stringify({ email: 'x' }))).toBeNull();
  });
});

describe('federatedUserSync handler (#783)', () => {
  let store: FederatedUserStore;
  let userExists: ReturnType<typeof vi.fn>;
  let createUser: ReturnType<typeof vi.fn>;
  let ensureReputation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    userExists = vi.fn<(s: string) => Promise<boolean>>().mockResolvedValue(false);
    createUser = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    ensureReputation = vi.fn<(s: string) => Promise<void>>().mockResolvedValue(undefined);
    store = { userExists, createUser, ensureReputation } as unknown as FederatedUserStore;
    __setStore(store);
  });
  afterEach(() => __setStore(undefined));

  it('ensures a row per valid record', async () => {
    await handler(
      sqsEvent([JSON.stringify({ cognitoSub: 'google_1', email: 'a@b.c' })]),
      {} as never,
      () => undefined,
    );
    expect(createUser).toHaveBeenCalledOnce();
    expect(ensureReputation).toHaveBeenCalledWith('google_1');
  });

  it('skips unparseable records without throwing', async () => {
    await handler(sqsEvent(['garbage']), {} as never, () => undefined);
    expect(createUser).not.toHaveBeenCalled();
  });
});
