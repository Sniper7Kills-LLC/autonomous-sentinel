import { describe, it, expect } from 'vitest';
import { auth, authConfig } from './resource';
import { postConfirmation } from '../functions/postConfirmation/resource';

describe('auth resource', () => {
  it('exports an Amplify auth resource', () => {
    expect(auth).toBeDefined();
  });

  it('enables email login (drives email verification on signup)', () => {
    expect(authConfig.loginWith.email).toBe(true);
  });

  it('creates admin, moderator, and member groups', () => {
    expect(authConfig.groups).toEqual(['admin', 'moderator', 'member']);
  });

  it('requires email as a mutable standard attribute', () => {
    expect(authConfig.userAttributes?.email).toEqual({ required: true, mutable: true });
  });

  it('exposes preferredUsername as an optional mutable attribute', () => {
    expect(authConfig.userAttributes?.preferredUsername).toEqual({
      required: false,
      mutable: true,
    });
  });

  it('does not enable Cognito Advanced Security Features (cost — v1 deferral)', () => {
    expect('userPoolOverrides' in authConfig).toBe(false);
  });

  it('federates Google with email + profile scopes (issue #13)', () => {
    const google = authConfig.loginWith.externalProviders.google;
    expect(google).toBeDefined();
    expect(google.scopes).toEqual(['email', 'profile']);
    // clientId / clientSecret are `secret()` placeholders — resolved at deploy
    // time. We assert presence + non-string shape (string would imply a
    // hardcoded credential leak in source).
    expect(google.clientId).toBeDefined();
    expect(typeof google.clientId).not.toBe('string');
    expect(google.clientSecret).toBeDefined();
    expect(typeof google.clientSecret).not.toBe('string');
  });

  it('maps Google email claim to the Cognito email attribute', () => {
    expect(authConfig.loginWith.externalProviders.google.attributeMapping).toEqual({
      email: 'email',
    });
  });

  it('registers localhost + beta.eam.watch as OAuth callback + logout URLs', () => {
    const expected = ['http://localhost:3000/', 'https://beta.eam.watch/'];
    expect(authConfig.loginWith.externalProviders.callbackUrls).toEqual(expected);
    expect(authConfig.loginWith.externalProviders.logoutUrls).toEqual(expected);
  });

  it('registers the postConfirmation trigger (issue #15)', () => {
    expect(authConfig.triggers?.postConfirmation).toBe(postConfirmation);
  });

  it('grants addUserToGroup access to the postConfirmation Lambda', () => {
    type AccessFn = NonNullable<typeof authConfig.access>;
    const allow = {
      resource: (r: unknown) => ({
        to: (actions: string[]) => ({ resource: r, actions }),
      }),
    } as unknown as Parameters<AccessFn>[0];
    const defs = authConfig.access(allow) as unknown as Array<{
      resource: unknown;
      actions: string[];
    }>;
    expect(defs).toHaveLength(1);
    expect(defs[0]?.resource).toBe(postConfirmation);
    expect(defs[0]?.actions).toEqual(['addUserToGroup']);
  });
});
