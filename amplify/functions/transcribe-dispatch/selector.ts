/**
 * Transcribe-backend selector (#58).
 *
 * Resolves which transcribe backend runs for a given Recording.
 * Per CLAUDE.md → Pipeline components → Transcribe Lambda:
 * "pluggable backend, env-wide admin default + per-recording
 * override (admin can re-run a single recording on a different
 * backend for comparison)".
 *
 * Resolution order, first hit wins:
 *   1. `messageOverride` — admin-set per-recording override on
 *      the SQS dispatch message (the admin "rerun on backend X"
 *      mutation).
 *   2. `config.defaultBackend` — env-wide admin default from
 *      the deferred `PipelineConfig` DDB row.
 *   3. `DEFAULT_TRANSCRIBE_BACKEND` (`'whisper-local'`) hard-coded
 *      fallback so a fresh sandbox without the config row still
 *      transcribes correctly.
 *
 * Pure JS. The deferred dispatcher Lambda calls `resolveBackend`,
 * looks up the matching backend function ARN from env, and
 * async-invokes (Event invocation) so the dispatcher returns
 * fast.
 *
 * Defensive: an unknown / typo'd backend name in either the
 * override or the config falls through to the next resolution
 * step with a CloudWatch warn. A corrupted admin-edited row
 * can't silently route every Recording to a non-existent
 * backend.
 */

/** The four backends in CLAUDE.md → Transcribe Lambda. */
export const TRANSCRIBE_BACKENDS = [
  'whisper-local',
  'whisper-api',
  'amazon-transcribe',
  'bedrock',
] as const;
export type TranscribeBackend = (typeof TRANSCRIBE_BACKENDS)[number];

export const DEFAULT_TRANSCRIBE_BACKEND: TranscribeBackend = 'whisper-local';

export function isTranscribeBackend(value: unknown): value is TranscribeBackend {
  return typeof value === 'string' && (TRANSCRIBE_BACKENDS as readonly string[]).includes(value);
}

export interface TranscribeBackendConfig {
  /**
   * Admin-set env-wide default backend. Sourced from the deferred
   * `PipelineConfig` DDB row `pk=transcribe`. `undefined` when
   * the row hasn't been seeded yet.
   */
  defaultBackend?: string | null;
}

export interface DispatchMessage {
  recordingId: string;
  /**
   * Per-Recording override from the admin "rerun on backend X"
   * mutation (deferred). Loose-typed (`string`) so a malformed
   * upstream message degrades gracefully — the resolver validates
   * + warns + falls through, instead of letting a bad value
   * surface as an `unknown function ARN` Lambda invocation
   * failure later in the pipeline.
   */
  backendOverride?: string | null;
}

interface ResolveOpts {
  /**
   * Fallback used when neither the override nor the config supplies
   * a valid backend. Defaults to `DEFAULT_TRANSCRIBE_BACKEND`.
   * Tests override to assert the fallthrough behaviour.
   */
  hardcodedDefault?: TranscribeBackend;
}

/**
 * Resolves the active backend for a dispatch message. Falls
 * through to the next resolution step on an unknown / invalid
 * value, with a CloudWatch warn so admins see the misconfig.
 */
export function resolveBackend(
  message: DispatchMessage,
  config: TranscribeBackendConfig,
  opts: ResolveOpts = {},
): TranscribeBackend {
  const override = message.backendOverride;
  if (isTranscribeBackend(override)) return override;
  if (override) {
    console.warn('transcribe-selector: ignoring unknown per-recording override', {
      recordingId: message.recordingId,
      backendOverride: override,
    });
  }

  const fromConfig = config.defaultBackend;
  if (isTranscribeBackend(fromConfig)) return fromConfig;
  if (fromConfig) {
    console.warn('transcribe-selector: ignoring unknown config defaultBackend', {
      defaultBackend: fromConfig,
    });
  }

  return opts.hardcodedDefault ?? DEFAULT_TRANSCRIBE_BACKEND;
}

/**
 * Env-var lookup map from backend → function ARN. The deferred
 * dispatcher Lambda populates these via `defineFunction` env
 * wiring; the helper here returns the matching ARN or throws so
 * a misconfigured environment fails loudly at dispatch time
 * rather than producing a silent no-op.
 */
export const BACKEND_ENV_VAR: Record<TranscribeBackend, string> = {
  'whisper-local': 'WHISPER_LOCAL_FN_ARN',
  'whisper-api': 'WHISPER_API_FN_ARN',
  'amazon-transcribe': 'AMAZON_TRANSCRIBE_FN_ARN',
  bedrock: 'BEDROCK_TRANSCRIBE_FN_ARN',
};

interface ArnEnvOpts {
  /**
   * Source of env vars. Defaults to `process.env`. Tests inject
   * an in-memory object so they can pin which ARN is returned.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Returns the Lambda function ARN for the chosen backend.
 * Throws when the matching env var is unset so a misconfigured
 * deployment crashes at the first dispatch instead of silently
 * dropping Recordings on the floor.
 */
export function resolveBackendArn(backend: TranscribeBackend, opts: ArnEnvOpts = {}): string {
  const env = opts.env ?? process.env;
  const varName = BACKEND_ENV_VAR[backend];
  const arn = env[varName];
  if (!arn) {
    throw new Error(`transcribe-selector: env var ${varName} is unset for backend ${backend}`);
  }
  return arn;
}
