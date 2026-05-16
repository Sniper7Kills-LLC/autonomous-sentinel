import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyHandlerV2,
} from 'aws-lambda';
import { SignJWT, importPKCS8, importSPKI, exportJWK } from 'jose';

/**
 * Discord OIDC bridge — single Lambda fronting an HTTPS function URL.
 *
 * Route matrix:
 *   GET  /.well-known/openid-configuration → discovery doc
 *   GET  /.well-known/jwks.json            → signing key (JWK)
 *   GET  /authorize                        → 302 to Discord OAuth authorize
 *   POST /token                            → exchange Discord code, return id_token
 *   GET  /userinfo                         → Discord profile mapped to OIDC claims
 *
 * Issuer = the function URL itself (set in env at deploy time by backend.ts).
 */

const DISCORD_AUTHORIZE = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const DISCORD_USERINFO = 'https://discord.com/api/users/@me';
const KID = 'discord-bridge-v1';
const TOKEN_TTL_SECONDS = 600;

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  email?: string;
  verified?: boolean;
}

function getIssuer(event: APIGatewayProxyEventV2): string {
  const env = process.env.OIDC_ISSUER;
  if (env) return env.replace(/\/$/, '');
  const host = event.requestContext.domainName;
  return `https://${host}`;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function handleDiscovery(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  const issuer = getIssuer(event);
  return jsonResponse(200, {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    claims_supported: ['sub', 'email', 'email_verified', 'preferred_username', 'name'],
  });
}

async function handleJwks(): Promise<APIGatewayProxyResultV2> {
  const pem = requireEnv('DISCORD_BRIDGE_PUBLIC_KEY');
  const key = await importSPKI(pem, 'RS256', { extractable: true });
  const jwk = await exportJWK(key);
  return jsonResponse(200, {
    keys: [{ ...jwk, alg: 'RS256', use: 'sig', kid: KID }],
  });
}

function handleAuthorize(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  const q = event.queryStringParameters ?? {};
  const clientId = requireEnv('DISCORD_CLIENT_ID');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'identify email',
    redirect_uri: q.redirect_uri ?? '',
    state: q.state ?? '',
  });
  if (q.prompt) params.set('prompt', q.prompt);
  return {
    statusCode: 302,
    headers: { location: `${DISCORD_AUTHORIZE}?${params.toString()}` },
    body: '',
  };
}

async function handleToken(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = decodeForm(event);
  const code = body.get('code');
  const redirectUri = body.get('redirect_uri');
  if (!code || !redirectUri) {
    return jsonResponse(400, { error: 'invalid_request' });
  }

  const clientId = requireEnv('DISCORD_CLIENT_ID');
  const clientSecret = requireEnv('DISCORD_CLIENT_SECRET');

  const tokenRes = await fetch(DISCORD_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!tokenRes.ok) {
    return jsonResponse(tokenRes.status, { error: 'invalid_grant' });
  }
  const discordTok = (await tokenRes.json()) as DiscordTokenResponse;

  const userRes = await fetch(DISCORD_USERINFO, {
    headers: { authorization: `Bearer ${discordTok.access_token}` },
  });
  if (!userRes.ok) {
    return jsonResponse(502, { error: 'discord_userinfo_failed' });
  }
  const user = (await userRes.json()) as DiscordUser;

  const issuer = getIssuer(event);
  const privateKey = await importPKCS8(requireEnv('DISCORD_BRIDGE_PRIVATE_KEY'), 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({
    email: user.email,
    email_verified: user.verified ?? false,
    preferred_username: user.username,
    name: user.global_name ?? user.username,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(issuer)
    .setSubject(user.id)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .sign(privateKey);

  return jsonResponse(200, {
    access_token: discordTok.access_token,
    token_type: 'Bearer',
    expires_in: discordTok.expires_in,
    id_token: idToken,
    scope: 'openid email profile',
  });
}

async function handleUserinfo(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const auth = event.headers?.authorization ?? event.headers?.Authorization;
  if (!auth?.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'invalid_token' });
  }
  const accessToken = auth.slice('Bearer '.length);

  const userRes = await fetch(DISCORD_USERINFO, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) {
    return jsonResponse(userRes.status, { error: 'invalid_token' });
  }
  const user = (await userRes.json()) as DiscordUser;
  return jsonResponse(200, {
    sub: user.id,
    email: user.email,
    email_verified: user.verified ?? false,
    preferred_username: user.username,
    name: user.global_name ?? user.username,
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

function decodeForm(event: APIGatewayProxyEventV2): URLSearchParams {
  const raw = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : '';
  return new URLSearchParams(raw);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const path = event.requestContext.http.path;
  const method = event.requestContext.http.method.toUpperCase();

  if (method === 'GET' && path === '/.well-known/openid-configuration') {
    return handleDiscovery(event);
  }
  if (method === 'GET' && path === '/.well-known/jwks.json') {
    return handleJwks();
  }
  if (method === 'GET' && path === '/authorize') {
    return handleAuthorize(event);
  }
  if (method === 'POST' && path === '/token') {
    return handleToken(event);
  }
  if (method === 'GET' && path === '/userinfo') {
    return handleUserinfo(event);
  }
  return jsonResponse(404, { error: 'not_found' });
};
