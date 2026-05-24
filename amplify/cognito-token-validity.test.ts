import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  applyCognitoTokenValidity,
  COGNITO_TOKEN_VALIDITY_DEFAULTS,
  readCognitoTokenValidityConfig,
} from './cognito-token-validity';

/**
 * Cognito token TTL contract (#333).
 *
 * Defaults explicitly pin Cognito's CDK defaults so a future Amplify
 * upgrade can't silently shift them. Env overrides are bounds-checked
 * because pasting a typo into a CFN template can lock the pool into a
 * rotation cadence nobody wanted.
 */

const ENV_KEYS = [
  'AS_COGNITO_ACCESS_TOKEN_MIN',
  'AS_COGNITO_ID_TOKEN_MIN',
  'AS_COGNITO_REFRESH_TOKEN_MIN',
  'AS_COGNITO_AUTH_SESSION_MIN',
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('cognito-token-validity — defaults', () => {
  it('pins access token to 60 minutes (1 hour)', () => {
    expect(COGNITO_TOKEN_VALIDITY_DEFAULTS.accessTokenValidityMinutes).toBe(60);
  });

  it('pins id token to 60 minutes (1 hour)', () => {
    expect(COGNITO_TOKEN_VALIDITY_DEFAULTS.idTokenValidityMinutes).toBe(60);
  });

  it('pins refresh token to 43200 minutes (30 days)', () => {
    expect(COGNITO_TOKEN_VALIDITY_DEFAULTS.refreshTokenValidityMinutes).toBe(43200);
  });

  it('pins auth session to 3 minutes (Cognito SRP-challenge default)', () => {
    expect(COGNITO_TOKEN_VALIDITY_DEFAULTS.authSessionValidityMinutes).toBe(3);
  });
});

describe('cognito-token-validity — env override', () => {
  it.each([
    ['AS_COGNITO_ACCESS_TOKEN_MIN', '120', 'accessTokenValidityMinutes', 120],
    ['AS_COGNITO_ID_TOKEN_MIN', '120', 'idTokenValidityMinutes', 120],
    ['AS_COGNITO_REFRESH_TOKEN_MIN', '120', 'refreshTokenValidityMinutes', 120],
    ['AS_COGNITO_AUTH_SESSION_MIN', '10', 'authSessionValidityMinutes', 10],
  ] as const)('reads %s when set', (name, value, field, expected) => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env[name] = value;
    const cfg = readCognitoTokenValidityConfig();
    expect(cfg[field]).toBe(expected);
  });

  it('falls back to defaults when env is unset', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(readCognitoTokenValidityConfig()).toEqual(COGNITO_TOKEN_VALIDITY_DEFAULTS);
  });
});

describe('cognito-token-validity — bounds rejection', () => {
  it('rejects access token < 5 minutes (Cognito hard floor)', () => {
    process.env.AS_COGNITO_ACCESS_TOKEN_MIN = '4';
    expect(() => readCognitoTokenValidityConfig()).toThrow(/AS_COGNITO_ACCESS_TOKEN_MIN/);
  });

  it('rejects access token > 1440 minutes (24h Cognito hard ceiling)', () => {
    process.env.AS_COGNITO_ACCESS_TOKEN_MIN = '1441';
    expect(() => readCognitoTokenValidityConfig()).toThrow(/AS_COGNITO_ACCESS_TOKEN_MIN/);
  });

  it('rejects refresh token < 60 minutes (Cognito hard floor)', () => {
    process.env.AS_COGNITO_REFRESH_TOKEN_MIN = '59';
    expect(() => readCognitoTokenValidityConfig()).toThrow(/AS_COGNITO_REFRESH_TOKEN_MIN/);
  });

  it('rejects auth session > 15 minutes (Cognito hard ceiling)', () => {
    process.env.AS_COGNITO_AUTH_SESSION_MIN = '16';
    expect(() => readCognitoTokenValidityConfig()).toThrow(/AS_COGNITO_AUTH_SESSION_MIN/);
  });

  it('rejects non-integer values', () => {
    process.env.AS_COGNITO_ID_TOKEN_MIN = '60.5';
    expect(() => readCognitoTokenValidityConfig()).toThrow(/AS_COGNITO_ID_TOKEN_MIN/);
  });
});

describe('cognito-token-validity — applyCognitoTokenValidity', () => {
  function makeClientStub(): {
    client: Record<string, unknown>;
    capture: () => Record<string, unknown>;
  } {
    const client = {} as Record<string, unknown>;
    return { client, capture: () => client };
  }

  it('writes accessTokenValidity / idTokenValidity / refreshTokenValidity onto the L1 client', () => {
    const { client, capture } = makeClientStub();
    applyCognitoTokenValidity(
      client as unknown as Parameters<typeof applyCognitoTokenValidity>[0],
      COGNITO_TOKEN_VALIDITY_DEFAULTS,
    );
    const props = capture();
    expect(props.accessTokenValidity).toBe(60);
    expect(props.idTokenValidity).toBe(60);
    expect(props.refreshTokenValidity).toBe(43200);
  });

  it('sets tokenValidityUnits to minutes so the integers above are interpreted correctly', () => {
    const { client, capture } = makeClientStub();
    applyCognitoTokenValidity(
      client as unknown as Parameters<typeof applyCognitoTokenValidity>[0],
      COGNITO_TOKEN_VALIDITY_DEFAULTS,
    );
    expect(capture().tokenValidityUnits).toEqual({
      accessToken: 'minutes',
      idToken: 'minutes',
      refreshToken: 'minutes',
    });
  });
});
