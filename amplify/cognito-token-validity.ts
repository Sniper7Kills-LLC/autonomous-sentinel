import { type CfnUserPoolClient } from 'aws-cdk-lib/aws-cognito';

/**
 * Cognito token TTL tuning (issue #333).
 *
 * Amplify Gen 2 `defineAuth()` doesn't surface token validity options
 * directly. The choice still matters — token TTLs are the cycle on
 * which:
 *   - a banned user (#335) is forced back through PreAuth,
 *   - a role / reputation claim change (#334) reaches the JWT,
 *   - an admin's `selfDelete` ripple becomes invisible to the
 *     compromised tab.
 *
 * Default values below explicitly pin Cognito's CDK defaults so a
 * future Amplify upgrade can't silently shift them. Each is env-
 * tunable so the operator can shorten / lengthen without editing
 * source:
 *
 *   - `AS_COGNITO_ACCESS_TOKEN_MIN`  — default 60 (1 hour)
 *   - `AS_COGNITO_ID_TOKEN_MIN`      — default 60 (1 hour)
 *   - `AS_COGNITO_REFRESH_TOKEN_MIN` — default 43200 (30 days)
 *   - `AS_COGNITO_AUTH_SESSION_MIN`  — default 3
 *
 * Bounds checked. Refresh > 30 days needs deliberate action — the
 * longer the refresh window, the longer a banned user stays
 * effectively logged in via existing refresh tokens (we don't run
 * `AdminUserGlobalSignOut` on ban at v1, see #335 federation gap).
 *
 * Bounds:
 *   - access / id token: 5 min .. 24 hours (Cognito hard limits).
 *   - refresh token: 60 min .. 10 years (Cognito hard limits).
 *   - auth session: 3 .. 15 min (Cognito hard limits).
 */

export interface CognitoTokenValidityConfig {
  accessTokenValidityMinutes: number;
  idTokenValidityMinutes: number;
  refreshTokenValidityMinutes: number;
  authSessionValidityMinutes: number;
}

export const COGNITO_TOKEN_VALIDITY_DEFAULTS: CognitoTokenValidityConfig = {
  accessTokenValidityMinutes: 60,
  idTokenValidityMinutes: 60,
  refreshTokenValidityMinutes: 43200,
  authSessionValidityMinutes: 3,
};

const ACCESS_MIN_BOUNDS = { min: 5, max: 24 * 60 };
const ID_MIN_BOUNDS = { min: 5, max: 24 * 60 };
const REFRESH_MIN_BOUNDS = { min: 60, max: 10 * 365 * 24 * 60 };
const SESSION_MIN_BOUNDS = { min: 3, max: 15 };

function envInt(name: string, fallback: number, bounds: { min: number; max: number }): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `Invalid value for ${name}: '${raw ?? fallback}'. Expected an integer in [${bounds.min}, ${bounds.max}].`,
    );
  }
  return value;
}

export function readCognitoTokenValidityConfig(): CognitoTokenValidityConfig {
  return {
    accessTokenValidityMinutes: envInt(
      'AS_COGNITO_ACCESS_TOKEN_MIN',
      COGNITO_TOKEN_VALIDITY_DEFAULTS.accessTokenValidityMinutes,
      ACCESS_MIN_BOUNDS,
    ),
    idTokenValidityMinutes: envInt(
      'AS_COGNITO_ID_TOKEN_MIN',
      COGNITO_TOKEN_VALIDITY_DEFAULTS.idTokenValidityMinutes,
      ID_MIN_BOUNDS,
    ),
    refreshTokenValidityMinutes: envInt(
      'AS_COGNITO_REFRESH_TOKEN_MIN',
      COGNITO_TOKEN_VALIDITY_DEFAULTS.refreshTokenValidityMinutes,
      REFRESH_MIN_BOUNDS,
    ),
    authSessionValidityMinutes: envInt(
      'AS_COGNITO_AUTH_SESSION_MIN',
      COGNITO_TOKEN_VALIDITY_DEFAULTS.authSessionValidityMinutes,
      SESSION_MIN_BOUNDS,
    ),
  };
}

/**
 * Apply the configured TTLs to the auth construct's L1 user pool
 * client + user pool (auth session lives on the pool itself).
 */
export function applyCognitoTokenValidity(
  client: CfnUserPoolClient,
  config: CognitoTokenValidityConfig = readCognitoTokenValidityConfig(),
): void {
  client.accessTokenValidity = config.accessTokenValidityMinutes;
  client.idTokenValidity = config.idTokenValidityMinutes;
  client.refreshTokenValidity = config.refreshTokenValidityMinutes;
  client.tokenValidityUnits = {
    accessToken: 'minutes',
    idToken: 'minutes',
    refreshToken: 'minutes',
  };
}
