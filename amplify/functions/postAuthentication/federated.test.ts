import { describe, it, expect } from 'vitest';
import { isFederated, extractFederatedIdentity } from './federated';

describe('isFederated (#783)', () => {
  it('true for a non-empty identities JSON array', () => {
    expect(isFederated({ identities: '[{"providerName":"Discord"}]' })).toBe(true);
  });
  it('false for native (no identities)', () => {
    expect(isFederated({ sub: 'x' })).toBe(false);
  });
  it('false for an empty identities array', () => {
    expect(isFederated({ identities: '[]' })).toBe(false);
  });
});

describe('extractFederatedIdentity (#783)', () => {
  it('maps a federated event to the sync payload', () => {
    const out = extractFederatedIdentity({
      request: {
        userAttributes: {
          identities: '[{"providerName":"Google"}]',
          sub: 'google_42',
          email: 'op@example.com',
          name: 'Mainsail Operator',
          preferred_username: 'mainsail',
        },
      },
    });
    expect(out).toEqual({
      cognitoSub: 'google_42',
      email: 'op@example.com',
      displayName: 'Mainsail Operator',
      preferredUsername: 'mainsail',
    });
  });

  it('returns null for a native sign-in', () => {
    expect(
      extractFederatedIdentity({
        request: { userAttributes: { sub: 'native_1', email: 'a@b.c' } },
      }),
    ).toBeNull();
  });

  it('returns null when federated but sub is missing', () => {
    expect(
      extractFederatedIdentity({ request: { userAttributes: { identities: '[{"x":1}]' } } }),
    ).toBeNull();
  });

  it('nulls absent optional fields', () => {
    const out = extractFederatedIdentity({
      request: { userAttributes: { identities: '[{"providerName":"Discord"}]', sub: 's' } },
    });
    expect(out).toEqual({
      cognitoSub: 's',
      email: null,
      displayName: null,
      preferredUsername: null,
    });
  });
});
