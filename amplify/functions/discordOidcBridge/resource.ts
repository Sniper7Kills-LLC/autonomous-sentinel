import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * In-house Discord OAuth 2.0 → OIDC bridge (issue #14).
 *
 * Cognito's OIDC IdP requires OIDC discovery + an `id_token` from the upstream
 * provider. Discord only speaks OAuth 2.0, so this Lambda translates: it
 * exposes the OIDC surface (`/.well-known/openid-configuration`, JWKS,
 * `/authorize`, `/token`, `/userinfo`), forwards the user to Discord's OAuth
 * authorize endpoint, exchanges the returned code for a Discord access token,
 * fetches the user's profile, and mints a signed RS256 id_token for Cognito.
 *
 * CLAUDE.md gives us first refusal on the OSS `cognito-discord-oidc-bridge`
 * package; per project direction we are writing our own (~150 LOC) instead so
 * we own the signing keys and the upgrade path.
 *
 * Required secrets (set with `npx ampx sandbox secret set <NAME>` before
 * deploy):
 *   - DISCORD_CLIENT_ID
 *   - DISCORD_CLIENT_SECRET
 *   - DISCORD_BRIDGE_PRIVATE_KEY  — PEM-encoded RSA 2048 private key
 *   - DISCORD_BRIDGE_PUBLIC_KEY   — PEM-encoded matching public key
 *
 * The function URL is added in `backend.ts` and passed through as the
 * `OIDC_ISSUER` env var via a CDK token, so id_tokens carry the right `iss`.
 * Cognito's OIDC IdP wiring (issue #254) consumes the same token directly via
 * a CDK escape hatch — no hardcoded URL, single deploy.
 */
export const discordOidcBridge = defineFunction({
  name: 'discordOidcBridge',
  entry: './handler.ts',
  timeoutSeconds: 10,
  memoryMB: 256,
  environment: {
    DISCORD_CLIENT_ID: secret('DISCORD_CLIENT_ID'),
    DISCORD_CLIENT_SECRET: secret('DISCORD_CLIENT_SECRET'),
    DISCORD_BRIDGE_PRIVATE_KEY: secret('DISCORD_BRIDGE_PRIVATE_KEY'),
    DISCORD_BRIDGE_PUBLIC_KEY: secret('DISCORD_BRIDGE_PUBLIC_KEY'),
  },
});
