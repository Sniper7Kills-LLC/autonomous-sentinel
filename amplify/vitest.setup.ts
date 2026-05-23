import { vi } from 'vitest';

/**
 * Global vitest setup for the amplify workspace.
 *
 * `@aws-appsync/utils` exports the `util` runtime helper used inside
 * AppSync JS resolvers (`util.error`, `util.time.nowISO8601`, …).
 * The npm package is types-only — the actual implementations live in
 * the deployed AppSync runtime, not in Node. Resolver unit tests
 * import the .js files directly, so without a mock every call to
 * `util.*` throws `TypeError: Cannot read properties of undefined`.
 *
 * Mock the surface the resolvers actually call:
 *   - `util.error(message, type?, data?)` — throws like AppSync's
 *     "field error" semantics so test assertions on validation paths
 *     still see a thrown error (previously these were
 *     `throw new Error(...)` calls).
 *   - `util.time.nowISO8601()` — returns a stable test timestamp so
 *     tests that assert on `lastCastAt` / `firstCastAt` shape can
 *     pin the exact string.
 *
 * Stable timestamp is `2026-01-01T00:00:00.000Z`. Tests that need a
 * different value can override per-test via vi.mocked()/vi.spyOn().
 */
vi.mock('@aws-appsync/utils', () => ({
  util: {
    // **Real APPSYNC_JS behaviour caveat**: the deployed runtime's
    // `util.error(...)` aborts the resolver and surfaces the message
    // to the GraphQL response without propagating to JS-level
    // try/catch blocks the way a thrown Error does. We mock with a
    // throw so existing `expect(...).toThrow(/msg/)` test assertions
    // keep working — match the prior `throw new Error(...)` shape
    // that the resolvers were rewritten away from. **Do not wrap
    // `util.error(...)` in a try/catch inside any resolver** —
    // tests would mask a real-runtime behavior difference where the
    // catch never fires in production. The `validate-resolvers.ts`
    // script also walks for this drift via `appsync:EvaluateCode`.
    error: (message: string, _type?: string, _data?: unknown, _errorInfo?: unknown): never => {
      const err = new Error(message);
      throw err;
    },
    time: {
      nowISO8601: (): string => '2026-01-01T00:00:00.000Z',
      nowEpochSeconds: (): number => 1767225600,
      nowEpochMilliSeconds: (): number => 1767225600000,
    },
  },
}));
