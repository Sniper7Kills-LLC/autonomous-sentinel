/**
 * Canonical "write request" matcher for the read-vs-write ban scope (#201).
 *
 * A write-scope ban (the CLAUDE.md default) must block writes while letting a
 * blocked-country visitor keep browsing the public archive. The hard part is
 * that, at the WAF/CloudFront layer, a GraphQL **query** and a GraphQL
 * **mutation** are indistinguishable — both are `POST /graphql` with the
 * operation buried in the request body. Blocking every `POST /graphql` would
 * break anonymous browse (the site reads via AppSync), violating the
 * "can still browse" rule.
 *
 * v1 decision: a write request = an HTTP method in {POST, PUT, DELETE, PATCH}
 * targeting the unambiguous write surfaces `/api/*` (the authenticated REST
 * write API) or `/stripe/*` (Stripe Checkout). This blocks the REST write API,
 * uploads, and Stripe at the edge for write-scope bans, without touching
 * GraphQL browse traffic.
 *
 * Authenticated GraphQL **mutations** from banned *users* stay covered by the
 * existing per-user `User.bannedAt` checks (preAuth #335 / federated #412 /
 * the submit-path ban checks). The country/IP WAF block is a coarse,
 * anonymous-surface anti-abuse tool layered on top of that precise per-user
 * control — not a replacement for it.
 *
 * Deferred: GraphQL request-body inspection (byteMatch on the body for
 * `"mutation"`) to also block anonymous GraphQL mutations at the edge. It is
 * fragile (8 KB CloudFront body cap, oversize handling, false positives on
 * the word "mutation" in a query) and earns its own follow-up issue.
 *
 * Two serializers are exported because the matcher is consumed in two casings:
 *   - `buildWritePathStatement()`  → wafv2 **SDK** shape (PascalCase) embedded
 *     into the runtime-injected geo rules by the `wafSync` handler.
 *   - `buildWritePathStatementCdk()` → CDK **L1** shape (camelCase) embedded
 *     into the static IP-block rule in `amplify/waf.ts`.
 * Both are built from the same `WRITE_METHODS` / `WRITE_PATH_PREFIXES`
 * source-of-truth, asserted equal in the tests.
 */

export type WafStatement = Record<string, unknown>;

/** HTTP methods treated as writes. Compared case-insensitively. */
export const WRITE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;

/** URI path prefixes treated as write surfaces (already lowercase). */
export const WRITE_PATH_PREFIXES = ['/api/', '/stripe/'] as const;

/**
 * Pure predicate mirroring the WAF statement intent — the unit-test anchor for
 * "what counts as a write". Keep this in lock-step with the statement builders.
 */
export function isWriteRequest(method: string, path: string): boolean {
  const m = String(method ?? '').toUpperCase();
  const p = String(path ?? '');
  const methodIsWrite = (WRITE_METHODS as readonly string[]).includes(m);
  const pathIsWrite = WRITE_PATH_PREFIXES.some((prefix) => p.toLowerCase().startsWith(prefix));
  return methodIsWrite && pathIsWrite;
}

/**
 * The two component conditions of a write request — a method `OrStatement` and
 * a path `OrStatement` — as wafv2 SDK (PascalCase) statements.
 *
 * Returned as a flat ARRAY (not wrapped in their own `AndStatement`) because
 * the caller spreads them into the rule's existing `AndStatement` alongside the
 * geo / IP-set match. WAF rejects an `AndStatement` nested directly inside
 * another `AndStatement` ("nested statement is not valid, field: AND_STATEMENT"),
 * so the conditions must be flattened into a single AND.
 */
export function writePathStatements(): WafStatement[] {
  return [
    {
      OrStatement: {
        Statements: WRITE_METHODS.map((method) => ({
          ByteMatchStatement: {
            FieldToMatch: { Method: {} },
            PositionalConstraint: 'EXACTLY',
            SearchString: method,
            TextTransformations: [{ Priority: 0, Type: 'NONE' }],
          },
        })),
      },
    },
    {
      OrStatement: {
        Statements: WRITE_PATH_PREFIXES.map((prefix) => ({
          ByteMatchStatement: {
            FieldToMatch: { UriPath: {} },
            PositionalConstraint: 'STARTS_WITH',
            SearchString: prefix,
            TextTransformations: [{ Priority: 0, Type: 'LOWERCASE' }],
          },
        })),
      },
    },
  ];
}

/** CDK L1 (camelCase) equivalent of {@link writePathStatements}. */
export function writePathStatementsCdk(): WafStatement[] {
  return [
    {
      orStatement: {
        statements: WRITE_METHODS.map((method) => ({
          byteMatchStatement: {
            fieldToMatch: { method: {} },
            positionalConstraint: 'EXACTLY',
            searchString: method,
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        })),
      },
    },
    {
      orStatement: {
        statements: WRITE_PATH_PREFIXES.map((prefix) => ({
          byteMatchStatement: {
            fieldToMatch: { uriPath: {} },
            positionalConstraint: 'STARTS_WITH',
            searchString: prefix,
            textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
          },
        })),
      },
    },
  ];
}
