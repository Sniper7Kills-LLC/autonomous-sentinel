/**
 * AppSync JS resolver validator (#10 follow-up — protect future deploys
 * from the "code contains one or more errors" CFN failures that the
 * APPSYNC_JS runtime surfaces only at create time).
 *
 * Walks every `*.js` file under `amplify/data/models/resolvers/`,
 * extracts the `request` and `response` exports, and ships the source
 * to the AppSync `EvaluateCode` API one function at a time. AppSync
 * runs the same parser + sandbox the deployed runtime uses, so any
 * unsupported language feature / global / pattern surfaces here
 * BEFORE it lands in a CFN template.
 *
 * Usage:
 *   AWS_PROFILE=eamwatch npm run --workspace amplify validate-resolvers
 *
 * Exits 0 when every resolver is accepted by AppSync, non-zero with
 * a per-file error list otherwise. Skips a file when it lacks both
 * `request` and `response` exports (defensive — not every file under
 * `resolvers/` has to be an AppSync entry point).
 *
 * Requires AWS credentials that can call `appsync:EvaluateCode` — the
 * `eamwatch` sandbox profile has the read-only access this needs. CI
 * runs without AWS creds, so this script is NOT wired into the default
 * `npm test` path; it's a developer + pre-deploy smoke check.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppSyncClient, EvaluateCodeCommand } from '@aws-sdk/client-appsync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RESOLVERS_DIR = resolve(__dirname, '..', 'data', 'models', 'resolvers');

// Minimal context payload the request / response evaluators accept.
// We bias toward a "satisfies every resolver's validation" shape so a
// resolver's own `util.error()` firing is not mistaken for a runtime
// rejection of the code itself. Anything missing here surfaces as a
// runtime `util.error(...)` message — distinguishable from a parse
// error by `isParseError()` below.
const REQUEST_CONTEXT = JSON.stringify({
  arguments: {
    email: 'voter@example.com',
    messageId: 'msg-1',
    revisionId: 'rev-1',
    field: 'SENDER',
    value: 'UP',
    reason: 'MANUAL',
  },
  identity: { sub: 'cog-sub-001' },
});
const RESPONSE_CONTEXT = JSON.stringify({
  arguments: {},
  result: { fieldKey: 'x#y#z' },
});

// AppSync EvaluateCode returns errors from BOTH the JS parser (the
// runtime rejecting unsupported syntax / globals) AND from the
// resolver's own `util.error()` runtime calls. Only the former is a
// drift we need to catch here — `util.error(...)` firing is the
// resolver doing its job. Parser errors carry one of these codes; a
// raw runtime error does not.
const PARSE_ERROR_PATTERNS = [
  /UNSUPPORTED_SYNTAX_TYPE/i,
  /INVALID_FUNCTION_INVOCATION/i,
  /Unsupported Syntax/i,
  /Invalid function/i,
];

function isParseError(message: string): boolean {
  return PARSE_ERROR_PATTERNS.some((re) => re.test(message));
}

interface FunctionCheck {
  fn: 'request' | 'response';
  ok: boolean;
  error?: string;
}

interface ResolverCheck {
  file: string;
  checks: FunctionCheck[];
}

function hasExport(source: string, fn: 'request' | 'response'): boolean {
  // Matches `export function request(` / `export async function request(`
  // and the destructured `export { request }` form. Newlines + whitespace
  // tolerated so an ESLint-formatted file is recognised.
  const direct = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${fn}\\s*\\(`, 'm');
  const reexport = new RegExp(`^export\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}`, 'm');
  return direct.test(source) || reexport.test(source);
}

async function evaluate(
  client: AppSyncClient,
  source: string,
  fn: 'request' | 'response',
): Promise<FunctionCheck> {
  try {
    const ctx = fn === 'request' ? REQUEST_CONTEXT : RESPONSE_CONTEXT;
    const result = await client.send(
      new EvaluateCodeCommand({
        runtime: { name: 'APPSYNC_JS', runtimeVersion: '1.0.0' },
        code: source,
        function: fn,
        context: ctx,
      }),
    );
    if (result.error) {
      const msg = result.error.message ?? 'unknown';
      // Parse errors mean the code itself is malformed for the
      // APPSYNC_JS runtime — fail the file. Runtime errors thrown
      // via `util.error(...)` mean the code IS valid, the resolver
      // just refused the (test) context — that's the resolver
      // working as designed. Note the runtime error in the report
      // but don't mark the file as failed.
      if (isParseError(msg)) {
        return { fn, ok: false, error: msg };
      }
      return { fn, ok: true, error: `runtime util.error: ${msg}` };
    }
    return { fn, ok: true };
  } catch (err) {
    return {
      fn,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const client = new AppSyncClient({ region });

  const entries = readdirSync(RESOLVERS_DIR, { withFileTypes: true });
  const jsFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .sort();

  if (jsFiles.length === 0) {
    console.error(`No resolver .js files found under ${RESOLVERS_DIR}`);
    process.exit(1);
  }

  console.info(`Validating ${jsFiles.length} AppSync JS resolver files via appsync:EvaluateCode`);
  console.info(`Region: ${region}`);
  console.info('');

  const reports: ResolverCheck[] = [];
  for (const file of jsFiles) {
    const filePath = resolve(RESOLVERS_DIR, file);
    const source = readFileSync(filePath, 'utf8');
    const checks: FunctionCheck[] = [];
    for (const fn of ['request', 'response'] as const) {
      if (!hasExport(source, fn)) {
        // Resolver file doesn't define this function — skip with a
        // benign "ok" note rather than a false-positive failure.
        continue;
      }
      checks.push(await evaluate(client, source, fn));
    }
    reports.push({ file, checks });
  }

  let failed = 0;
  for (const r of reports) {
    const fails = r.checks.filter((c) => !c.ok);
    if (fails.length === 0) {
      console.info(`  ok  ${r.file}`);
      continue;
    }
    failed += 1;
    console.info(`  FAIL  ${r.file}`);
    for (const f of fails) {
      console.info(`        [${f.fn}] ${f.error}`);
    }
  }

  console.info('');
  if (failed > 0) {
    console.error(`✗ ${failed} resolver file(s) rejected by AppSync.`);
    process.exit(1);
  }
  console.info(`✓ All ${reports.length} resolver files accepted by AppSync.`);
}

await main();
