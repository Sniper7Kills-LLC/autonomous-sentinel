/**
 * Type declarations for the `getUserPublic` AppSync JS resolver. The
 * implementation lives in `./get-user-public.js` (shipped as-is to AppSync
 * — the runtime doesn't transpile, so the source stays JS). These
 * declarations exist so unit tests can call `request` / `response`
 * with full type-checking.
 */

export interface GetUserPublicArgs {
  cognitoSub: string;
}

export interface IdentityClaims {
  /**
   * `cognito:groups` array from the request JWT. AppSync injects this
   * under `ctx.identity.groups` for Cognito-authenticated callers. Guests
   * + IAM callers have no groups, so admin detection naturally falls
   * through to the PII-filter branch.
   */
  groups?: readonly string[];
  sub?: string;
}

export interface GetUserPublicContext {
  arguments: GetUserPublicArgs;
  identity?: IdentityClaims | null;
  result?: UserRowFromDdb | null;
}

/**
 * Shape of a User row coming back from DDB. Only the PII fields matter
 * for the filter; everything else passes through untouched. Fields are
 * optional because pre-seeded migration rows may not have every column
 * populated yet (e.g. `cognitoSub` is `legacy:<id>` until claim).
 */
export interface UserRowFromDdb {
  cognitoSub?: string;
  email?: string | null;
  preferredUsername?: string | null;
  displayName?: string | null;
  role?: string | null;
  piiBlanked?: boolean | null;
  piiBlankedAt?: string | null;
  bannedAt?: string | null;
  [k: string]: unknown;
}

export interface AttributeValue {
  S?: string;
  N?: string;
  BOOL?: boolean;
}

export interface GetItemOperation {
  operation: 'GetItem';
  key: Record<string, AttributeValue>;
}

export function request(ctx: GetUserPublicContext): GetItemOperation;
export function response(ctx: GetUserPublicContext): UserRowFromDdb | null;
