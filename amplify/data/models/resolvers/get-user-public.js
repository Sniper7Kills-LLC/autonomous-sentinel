/**
 * AppSync JS resolver for the `getUserPublic` custom query (issue #248).
 *
 * Wraps a GetItem on the User table and applies the PII-blank filter on
 * response: when `piiBlanked=true`, `email` / `preferredUsername` /
 * `displayName` are returned as `null` to every caller except admins.
 *
 * Lives behind a custom query (not the model-default `getUser`) because
 * AppSync's default resolvers go straight to DynamoDB and bypass response
 * shaping — the only way to inject a deterministic per-caller filter is
 * to own the resolver outright.
 *
 * Admin reads route through the admin-only model resolver (User.get is
 * locked to `allow.groups(['admin'])` in the model authz), so this
 * wrapper carries the public + member + moderator paths. The admin
 * branch here is still guarded for the edge case of a wrapper-mode admin
 * call (e.g. an admin browsing the public profile UI) — defense in depth.
 *
 * Shipped as-is to AppSync (APPSYNC_JS runtime 1.0.0). No TypeScript;
 * types are declared in `./get-user-public.d.ts` and exercised by
 * `./get-user-public.test.ts`.
 */

/**
 * @typedef {Object} GetUserPublicArgs
 * @property {string} cognitoSub
 *
 * @typedef {Object} IdentityClaims
 * @property {readonly string[]} [groups]
 * @property {string} [sub]
 *
 * @typedef {Object} GetUserPublicContext
 * @property {GetUserPublicArgs} arguments
 * @property {IdentityClaims | null} [identity]
 * @property {Record<string, unknown> | null} [result]
 */

const PII_FIELDS = ['email', 'preferredUsername', 'displayName'];
const ADMIN_GROUP = 'admin';

/**
 * @param {IdentityClaims | null | undefined} identity
 */
function isAdmin(identity) {
  if (!identity || !identity.groups) return false;
  // Case-sensitive match — Cognito group names are case-sensitive at
  // signup, and a typo-tolerant filter here would silently un-blank PII
  // for misconfigured callers. Better to fail closed.
  return identity.groups.indexOf(ADMIN_GROUP) >= 0;
}

/**
 * @param {GetUserPublicContext} ctx
 */
export function request(ctx) {
  const { cognitoSub } = ctx.arguments;
  if (!cognitoSub || cognitoSub.trim() === '') {
    throw new Error('getUserPublic: cognitoSub argument is required');
  }
  return {
    operation: 'GetItem',
    key: { cognitoSub: { S: cognitoSub } },
  };
}

/**
 * @param {GetUserPublicContext} ctx
 */
export function response(ctx) {
  const row = ctx.result;
  if (row == null) return null;

  // Admin gets the unfiltered row, blanked PII + all.
  if (isAdmin(ctx.identity)) return row;

  // If the row was never PII-blanked, return as-is.
  if (!row.piiBlanked) return row;

  // PII-blanked + non-admin caller — null out the protected fields.
  // Build a new object so the request-pipeline `ctx.result` reference
  // stays untouched (AppSync caches it within the request).
  /** @type {Record<string, unknown>} */
  const filtered = {};
  for (const k of Object.keys(row)) {
    filtered[k] = row[k];
  }
  for (const field of PII_FIELDS) {
    filtered[field] = null;
  }
  return filtered;
}
