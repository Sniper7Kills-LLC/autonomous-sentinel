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

  it('does not register external providers at this stage (Google → #13, Discord → #14)', () => {
    expect('externalProviders' in authConfig.loginWith).toBe(false);
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
