import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  generateKeyPair,
  exportSPKI,
  exportPKCS8,
  jwtVerify,
  createLocalJWKSet,
  type JSONWebKeySet,
} from 'jose';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { handler } from './handler';

const ENV = {
  DISCORD_CLIENT_ID: 'discord-client',
  DISCORD_CLIENT_SECRET: 'discord-secret',
  OIDC_ISSUER: 'https://bridge.example.test',
};

const FETCH_MOCK = vi.fn();

function makeEvent(
  method: string,
  path: string,
  opts: Partial<APIGatewayProxyEventV2> & {
    query?: Record<string, string>;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: opts.headers ?? {},
    queryStringParameters: opts.query,
    requestContext: {
      accountId: '0',
      apiId: 'api',
      domainName: 'bridge.example.test',
      domainPrefix: 'bridge',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'rid',
      routeKey: '$default',
      stage: '$default',
      time: '1/1/1',
      timeEpoch: 0,
    },
    body: opts.body,
    isBase64Encoded: false,
  };
}

async function invoke(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await handler(event, {} as Context, () => undefined);
  if (!result || typeof result === 'string') throw new Error('handler returned no response');
  return result;
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  process.env.DISCORD_BRIDGE_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.DISCORD_BRIDGE_PUBLIC_KEY = await exportSPKI(publicKey);
  Object.assign(process.env, ENV);
});

beforeEach(() => {
  FETCH_MOCK.mockReset();
  vi.stubGlobal('fetch', FETCH_MOCK);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discord OIDC bridge', () => {
  it('serves a valid OIDC discovery document', async () => {
    const res = await invoke(makeEvent('GET', '/.well-known/openid-configuration'));
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body as string) as Record<string, unknown>;
    expect(doc.issuer).toBe(ENV.OIDC_ISSUER);
    expect(doc.authorization_endpoint).toBe(`${ENV.OIDC_ISSUER}/authorize`);
    expect(doc.token_endpoint).toBe(`${ENV.OIDC_ISSUER}/token`);
    expect(doc.userinfo_endpoint).toBe(`${ENV.OIDC_ISSUER}/userinfo`);
    expect(doc.jwks_uri).toBe(`${ENV.OIDC_ISSUER}/.well-known/jwks.json`);
    expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('exposes the public signing key as JWKS', async () => {
    const res = await invoke(makeEvent('GET', '/.well-known/jwks.json'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.kty).toBe('RSA');
    expect(body.keys[0]?.alg).toBe('RS256');
    expect(body.keys[0]?.use).toBe('sig');
    expect(body.keys[0]?.kid).toBe('discord-bridge-v1');
  });

  it('redirects /authorize to Discord with passthrough state + redirect_uri', () => {
    return invoke(
      makeEvent('GET', '/authorize', {
        query: {
          redirect_uri: 'https://eam.auth/cognito',
          state: 'opaque-state-123',
          prompt: 'consent',
        },
      }),
    ).then((res) => {
      expect(res.statusCode).toBe(302);
      const loc = res.headers?.location as string;
      expect(loc).toMatch(/^https:\/\/discord\.com\/api\/oauth2\/authorize\?/);
      const url = new URL(loc);
      expect(url.searchParams.get('client_id')).toBe('discord-client');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('identify email');
      expect(url.searchParams.get('redirect_uri')).toBe('https://eam.auth/cognito');
      expect(url.searchParams.get('state')).toBe('opaque-state-123');
      expect(url.searchParams.get('prompt')).toBe('consent');
    });
  });

  it('exchanges Discord code for a signed RS256 id_token', async () => {
    FETCH_MOCK.mockImplementation((url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u === 'https://discord.com/api/oauth2/token') {
        const body = new URLSearchParams(init?.body as string);
        expect(body.get('code')).toBe('the-code');
        expect(body.get('client_id')).toBe('discord-client');
        expect(body.get('client_secret')).toBe('discord-secret');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'discord-access',
              token_type: 'Bearer',
              expires_in: 604800,
              refresh_token: 'rt',
              scope: 'identify email',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (u === 'https://discord.com/api/users/@me') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: '12345',
              username: 'sentinel-user',
              global_name: 'Sentinel User',
              email: 'user@example.com',
              verified: true,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const event = makeEvent('POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Feam.auth%2Fcognito',
    });
    const res = await invoke(event);

    expect(res.statusCode).toBe(200);
    const tok = JSON.parse(res.body as string) as { id_token: string; access_token: string };
    expect(tok.access_token).toBe('discord-access');

    const jwksRes = await invoke(makeEvent('GET', '/.well-known/jwks.json'));
    const jwks = createLocalJWKSet(JSON.parse(jwksRes.body as string) as JSONWebKeySet);

    const verified = await jwtVerify(tok.id_token, jwks, {
      issuer: ENV.OIDC_ISSUER,
      audience: 'discord-client',
    });
    expect(verified.payload.sub).toBe('12345');
    expect(verified.payload.email).toBe('user@example.com');
    expect(verified.payload.email_verified).toBe(true);
    expect(verified.payload.preferred_username).toBe('sentinel-user');
    expect(verified.payload.name).toBe('Sentinel User');
    expect(verified.protectedHeader.kid).toBe('discord-bridge-v1');
    expect(verified.protectedHeader.alg).toBe('RS256');
  });

  it('returns 400 when /token is missing code or redirect_uri', async () => {
    const res = await invoke(
      makeEvent('POST', '/token', { body: 'grant_type=authorization_code' }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('propagates an invalid_grant error when Discord token exchange fails', async () => {
    FETCH_MOCK.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );

    const res = await invoke(
      makeEvent('POST', '/token', {
        body: 'grant_type=authorization_code&code=bad-code&redirect_uri=https%3A%2F%2Feam.auth%2Fcognito',
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body as string)).toEqual({ error: 'invalid_grant' });
    // Only the token call should have been made — no /users/@me follow-up.
    expect(FETCH_MOCK).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when /users/@me fails after a successful Discord token exchange', async () => {
    FETCH_MOCK.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'discord-access',
          token_type: 'Bearer',
          expires_in: 604800,
          scope: 'identify email',
        }),
        { status: 200 },
      ),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ message: '401: Unauthorized' }), { status: 401 }),
    );

    const res = await invoke(
      makeEvent('POST', '/token', {
        body: 'grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Feam.auth%2Fcognito',
      }),
    );

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body as string)).toEqual({ error: 'discord_userinfo_failed' });
    expect(FETCH_MOCK).toHaveBeenCalledTimes(2);
  });

  it('maps Discord profile to OIDC claims on /userinfo', async () => {
    FETCH_MOCK.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: '999',
          username: 'sirhc',
          global_name: null,
          email: 'sirhc@example.com',
          verified: false,
        }),
        { status: 200 },
      ),
    );

    const res = await invoke(
      makeEvent('GET', '/userinfo', { headers: { authorization: 'Bearer discord-access' } }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as Record<string, unknown>;
    expect(body.sub).toBe('999');
    expect(body.email).toBe('sirhc@example.com');
    expect(body.email_verified).toBe(false);
    expect(body.preferred_username).toBe('sirhc');
    expect(body.name).toBe('sirhc');
  });

  it('rejects /userinfo without a Bearer token', async () => {
    const res = await invoke(makeEvent('GET', '/userinfo'));
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await invoke(makeEvent('GET', '/nope'));
    expect(res.statusCode).toBe(404);
  });
});
