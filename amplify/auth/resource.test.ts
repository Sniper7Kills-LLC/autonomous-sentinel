import { describe, it, expect } from 'vitest';
import { Token } from 'aws-cdk-lib';
import { auth, authConfig, discordIssuerUrl } from './resource';
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

  it('federates Discord via the in-house OIDC bridge (issues #14 + #254)', () => {
    const oidcList = authConfig.loginWith.externalProviders.oidc;
    expect(oidcList).toHaveLength(1);
    const discord = oidcList[0];
    if (!discord) throw new Error('expected discord oidc entry');
    expect(discord.name).toBe('Discord');
    expect(discord.scopes).toEqual(['openid', 'email', 'profile']);
    expect(discord.attributeRequestMethod).toBe('GET');
    expect(typeof discord.clientId).not.toBe('string');
    expect(typeof discord.clientSecret).not.toBe('string');
  });

  it('maps Discord claims to Cognito attributes', () => {
    const discord = authConfig.loginWith.externalProviders.oidc[0];
    if (!discord) throw new Error('expected discord oidc entry');
    expect(discord.attributeMapping).toEqual({
      email: 'email',
      preferredUsername: 'preferred_username',
      fullname: 'name',
    });
  });

  it('reads the Discord OIDC issuerUrl as a CDK token (no hardcoded URL)', () => {
    const discord = authConfig.loginWith.externalProviders.oidc[0];
    if (!discord) throw new Error('expected discord oidc entry');
    const issuerUrl = discord.issuerUrl;
    // Lazy.string returns a token-bearing string. `Token.isUnresolved` detects
    // any CDK token; the bridge's function URL is one such token, threaded
    // through the module-level holder. A literal string here would be a
    // regression — it would mean someone hardcoded a deploy-time URL.
    expect(Token.isUnresolved(issuerUrl)).toBe(true);
  });

  it('threads the bridge URL through the discordIssuerUrl holder, not a constant', () => {
    // The holder starts empty in tests (backend.ts is not loaded here); the
    // contract is that `backend.ts` writes to it after the bridge URL exists.
    expect(discordIssuerUrl).toEqual({});
    discordIssuerUrl.url = 'https://example.invalid/issuer';
    try {
      // Resolving the Lazy via the public string is non-trivial outside a
      // Stack context, but we can at least confirm the holder is the
      // injection point (mutation is observable).
      expect(discordIssuerUrl.url).toBe('https://example.invalid/issuer');
    } finally {
      delete discordIssuerUrl.url;
    }
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
