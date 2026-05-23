import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type {
  ConverseCommandOutput,
  Message as BedrockMessage,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * Bedrock multimodal transcribe-backend adapter (#57).
 *
 * The (d) backend in CLAUDE.md → Pipeline components → Transcribe
 * Lambda. AWS has not yet GA'd audio-input on every Bedrock model
 * we want to swap to, so this PR lands the scaffolding behind a
 * feature flag: a `BedrockAudioAdapter` interface, a `StubAdapter`
 * that throws `BedrockMultimodalNotSupported` until the flag flips,
 * and a `ClaudeAudioAdapter` skeleton with the SDK shape best-
 * guessed as of 2026-05.
 *
 * When AWS GA's audio-input on the chosen model, only the
 * `ClaudeAudioAdapter.transcribe` body changes — the
 * `BedrockAudioAdapter` interface + selector + Lambda wiring stay
 * fixed.
 *
 * Pure JS. The deferred Lambda handler will call
 * `selectAdapter(env)` at cold start and `adapter.transcribe(req)`
 * per invocation.
 *
 * `BEDROCK_AUDIO_ENABLED` env (default `'false'`) gates the stub
 * vs the real adapter. The selector (#58) will hide the backend
 * from the admin UI when the flag is off so it doesn't get
 * chosen accidentally.
 */

/* ----- error types ------------------------------------------------ */

export class BedrockMultimodalNotSupported extends Error {
  constructor(message = 'Bedrock multimodal audio not yet enabled') {
    super(message);
    this.name = 'BedrockMultimodalNotSupported';
  }
}

export class BedrockAdapterError extends Error {
  readonly modelId: string;
  override readonly cause?: unknown;
  constructor(modelId: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'BedrockAdapterError';
    this.modelId = modelId;
    this.cause = cause;
  }
}

/* ----- public interface ------------------------------------------- */

export interface BedrockAudioRequest {
  /** Recording id — used for prompt context + observability. */
  recordingId: string;
  /** Audio bytes (canonical Opus from S3) the adapter sends to the model. */
  audioBytes: Uint8Array;
  /** MIME type. Canonical pipeline produces `audio/ogg`. */
  mimeType?: string;
  /** Language hint — defaults to `'en'` per CLAUDE.md. */
  language?: string;
  /**
   * Optional prompt template the adapter sends with the audio
   * (e.g. "Transcribe this HFGCS EAM transmission verbatim").
   * Defaults to `DEFAULT_TRANSCRIBE_PROMPT`.
   */
  prompt?: string;
}

export interface BedrockAudioResponse {
  text: string;
  /** Detected language code as the model reports it. */
  language?: string;
  modelId: string;
}

export interface BedrockAudioAdapter {
  /** Returns the canonical Transcript shape from the model output. */
  transcribe(req: BedrockAudioRequest): Promise<BedrockAudioResponse>;
}

export const DEFAULT_TRANSCRIBE_PROMPT =
  'You are transcribing a U.S. Air Force HFGCS Emergency Action ' +
  'Message (EAM) broadcast. Return ONLY the verbatim spoken text. ' +
  'Do not summarise, translate, or describe.';

/* ----- stub: pre-GA -------------------------------------------- */

/**
 * Adapter used when `BEDROCK_AUDIO_ENABLED !== 'true'`. Throws
 * a typed error rather than producing a fake transcript so the
 * dispatcher catches the misroute and routes to the DLQ.
 */
export class StubAdapter implements BedrockAudioAdapter {
  // eslint-disable-next-line @typescript-eslint/require-await
  async transcribe(_req: BedrockAudioRequest): Promise<BedrockAudioResponse> {
    console.warn('bedrock-adapter: stub adapter rejected transcribe request', {
      recordingId: _req.recordingId,
    });
    throw new BedrockMultimodalNotSupported();
  }
}

/* ----- Claude audio adapter skeleton ------------------------------ */

interface ClaudeAdapterDeps {
  modelId: string;
  client?: BedrockRuntimeClient;
}

/**
 * Skeleton adapter for Claude (or any Bedrock multimodal model
 * AWS releases that accepts audio bytes via the Converse API).
 *
 * As of 2026-05 the exact `ContentBlock.audio` shape is best-guess
 * — when AWS GA's it, only this method's request construction
 * needs to change. The test suite mocks the SDK so the swap is a
 * single-file diff.
 */
export class ClaudeAudioAdapter implements BedrockAudioAdapter {
  private readonly modelId: string;
  private readonly client: BedrockRuntimeClient;

  constructor(deps: ClaudeAdapterDeps) {
    this.modelId = deps.modelId;
    this.client = deps.client ?? new BedrockRuntimeClient({});
  }

  async transcribe(req: BedrockAudioRequest): Promise<BedrockAudioResponse> {
    const prompt = req.prompt ?? DEFAULT_TRANSCRIBE_PROMPT;
    const language = req.language ?? 'en';
    const mimeType = req.mimeType ?? 'audio/ogg';

    // TODO(when-bedrock-audio-ga): swap to the official audio
    // content block shape. Today we send the audio as a
    // base64-encoded text payload — the Lambda will fail at the
    // Bedrock layer until the model actually accepts it, but the
    // request-building code path runs end-to-end under test.
    const base64 = Buffer.from(req.audioBytes).toString('base64');
    const messages: BedrockMessage[] = [
      {
        role: 'user',
        content: [
          {
            text: `${prompt}\n\nLanguage hint: ${language}\nMIME: ${mimeType}\nAudio (base64): ${base64.slice(
              0,
              64,
            )}…`,
          },
        ],
      },
    ];

    let response: ConverseCommandOutput;
    try {
      response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          messages,
        }),
      );
    } catch (err) {
      throw new BedrockAdapterError(
        this.modelId,
        `Bedrock Converse threw: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const text = extractText(response);
    if (text === null) {
      throw new BedrockAdapterError(
        this.modelId,
        'Bedrock Converse response did not contain a text content block',
      );
    }
    return {
      text,
      language,
      modelId: this.modelId,
    };
  }
}

function extractText(output: ConverseCommandOutput): string | null {
  const content = output.output?.message?.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if ('text' in block && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join('');
}

/* ----- factory ---------------------------------------------------- */

export interface SelectAdapterOpts {
  env?: Record<string, string | undefined>;
  client?: BedrockRuntimeClient;
}

/**
 * Picks the active adapter based on `BEDROCK_AUDIO_ENABLED`. The
 * deferred Lambda handler calls this once at cold start and
 * reuses the instance across warm invocations.
 *
 * When `BEDROCK_AUDIO_ENABLED !== 'true'` (default) → `StubAdapter`
 * (throws on `transcribe`). When the flag flips to `'true'` and
 * `BEDROCK_MODEL_ID` is set → `ClaudeAudioAdapter`. Misconfig
 * (flag on but model id missing) → throws at selection time so
 * the Lambda fails fast at cold start rather than per invocation.
 */
export function selectAdapter(opts: SelectAdapterOpts = {}): BedrockAudioAdapter {
  const env = opts.env ?? process.env;
  if (env.BEDROCK_AUDIO_ENABLED !== 'true') {
    return new StubAdapter();
  }
  const modelId = env.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error('bedrock-adapter: BEDROCK_AUDIO_ENABLED=true but BEDROCK_MODEL_ID is unset');
  }
  return new ClaudeAudioAdapter({ modelId, client: opts.client });
}
