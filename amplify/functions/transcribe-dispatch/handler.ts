import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import {
  resolveBackend,
  resolveBackendArn,
  type DispatchMessage,
  type TranscribeBackend,
  type TranscribeBackendConfig,
} from './selector';

/**
 * Transcribe-dispatch Lambda (#587, epic #582 slice 2).
 *
 * Sits between the transcribe SQS queue and the four pluggable
 * transcribe backends (CLAUDE.md → Pipeline components → Transcribe
 * Lambda). It is the queue's sole consumer (`batchSize: 1`). For each
 * message it:
 *   1. Parses the SQS body into a {@link DispatchMessage} (the body the
 *      preprocess Lambda published: `{recordingId, originalKey,
 *      contentHash, enqueuedAt, backendOverride?}`).
 *   2. Resolves the active backend via `resolveBackend` — a per-message
 *      `backendOverride` wins, else the admin `PipelineConfig` default,
 *      else the hard-coded `whisper-local` (so today's happy path is
 *      unchanged: no override + no config row → whisper-local).
 *   3. Looks up that backend's function ARN from the env map
 *      (`resolveBackendArn` / `BACKEND_ENV_VAR`).
 *   4. **Async (InvocationType `Event`)** Lambda-invokes the backend
 *      with the ORIGINAL message body as the payload, then returns —
 *      the dispatcher never waits for transcription (30-min SLA → async
 *      between stages, per CLAUDE.md).
 *
 * Defensive posture:
 *   - An unknown / typo'd backend (override or config) falls through to
 *     the default inside `resolveBackend` (it warns); the dispatcher
 *     never hard-fails on a bad backend name.
 *   - A missing ARN env var for the resolved backend throws (via
 *     `resolveBackendArn`) so SQS redrives the message instead of
 *     silently dropping the Recording — a misconfigured deployment
 *     fails loud at the first dispatch.
 *
 * Test seam: `__setDeps({ lambda, loadConfig })` injects a stubbed
 * LambdaClient + an in-memory config loader so vitest never touches AWS.
 */

export interface TranscribeDispatchDeps {
  /** Lambda client used for the async backend invoke. */
  lambda?: LambdaClient;
  /**
   * Loads the env-wide default-backend config. Defaults to the
   * `DEFAULT_TRANSCRIBE_BACKEND` env var (the PipelineConfig DDB row is
   * deferred — env carries the admin default for v1). Injected in tests.
   */
  loadConfig?: () => Promise<TranscribeBackendConfig>;
  /** Env source for ARN lookups. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

let injected: TranscribeDispatchDeps = {};

export function __setDeps(deps: TranscribeDispatchDeps): void {
  injected = deps;
}

export function __resetDeps(): void {
  injected = {};
}

let cachedLambda: LambdaClient | undefined;
function lambdaClient(): LambdaClient {
  return injected.lambda ?? (cachedLambda ??= new LambdaClient({}));
}

function env(): Record<string, string | undefined> {
  return injected.env ?? process.env;
}

/**
 * Default config loader. The env-wide admin default backend lives in
 * `DEFAULT_TRANSCRIBE_BACKEND` for v1 (the `PipelineConfig` DDB row is
 * deferred); `resolveBackend` validates the value and falls through to
 * the hard-coded `whisper-local` on an unknown/empty value, so this is
 * safe even when the env var is unset.
 */
async function loadConfig(): Promise<TranscribeBackendConfig> {
  if (injected.loadConfig) return injected.loadConfig();
  return { defaultBackend: env().DEFAULT_TRANSCRIBE_BACKEND };
}

/**
 * Parses an SQS record body into a {@link DispatchMessage}. Returns
 * `null` when the body is unparseable JSON or carries no `recordingId`
 * — the caller logs + skips so one malformed message never poisons the
 * batch (matching the whisper handler's `parseBody` posture).
 */
export function parseDispatchMessage(record: SQSRecord): DispatchMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record?.body ?? '');
  } catch (err) {
    console.error('transcribe-dispatch: invalid SQS body JSON', { error: String(err) });
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.recordingId !== 'string' || obj.recordingId.trim() === '') {
    console.error('transcribe-dispatch: SQS body missing recordingId', { body: record?.body });
    return null;
  }
  return {
    recordingId: obj.recordingId,
    backendOverride: typeof obj.backendOverride === 'string' ? obj.backendOverride : undefined,
  };
}

/**
 * Resolves the backend + ARN for a message and async-invokes that
 * backend with the ORIGINAL message body as the payload. Exported so a
 * test can drive a single dispatch deterministically.
 *
 * `rawBody` is the exact SQS body string — forwarded verbatim so the
 * backend sees the same `{recordingId, originalKey, …}` shape it would
 * have read straight off the queue (no field re-mapping in the
 * dispatcher; backends own their own payload parsing).
 */
export async function dispatchOne(
  msg: DispatchMessage,
  rawBody: string,
  config: TranscribeBackendConfig,
): Promise<TranscribeBackend> {
  const backend = resolveBackend(msg, config);
  // Throws on a missing ARN env var → SQS redrives (fail loud).
  const functionArn = resolveBackendArn(backend, { env: env() });

  await lambdaClient().send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: 'Event',
      Payload: Buffer.from(rawBody),
    }),
  );

  console.info('transcribe-dispatch: routed recording to backend', {
    recordingId: msg.recordingId,
    backend,
    backendOverride: msg.backendOverride ?? '(none)',
    functionArn,
  });
  return backend;
}

/**
 * Lambda entrypoint. Consumes the transcribe SQS queue (`batchSize: 1`,
 * so `Records` holds one message in practice; the loop tolerates more).
 */
export async function handler(event: SQSEvent): Promise<{ ok: true }> {
  const config = await loadConfig();
  for (const record of event?.Records ?? []) {
    const msg = parseDispatchMessage(record);
    if (!msg) continue;
    await dispatchOne(msg, record.body, config);
  }
  return { ok: true };
}
