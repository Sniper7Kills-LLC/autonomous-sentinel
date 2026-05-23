import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  Message as BedrockMessage,
  Tool,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';

/**
 * Linguistic Logic Bedrock AI fallback (#63).
 *
 * Runs only when the rules engine (#62) returns null. Sends the
 * transcript to a Bedrock model with `tool_use` forcing the response
 * into the parsed-EAM schema below. On a schema-invalid response
 * the helper retries ONCE with a corrective system message before
 * giving up; persistent failure surfaces as `null` so the caller
 * can flip `parse_failed=true` on the Recording row.
 *
 * Bedrock stays inside AWS per CLAUDE.md → AI provider data-
 * residency. The model is admin-tunable via the
 * `LINGUISTIC_FALLBACK_MODEL_ID` env var so a Bedrock catalog
 * update doesn't require a redeploy.
 *
 * Default model: `anthropic.claude-sonnet-4-7-20250115-v1:0`
 * (Sonnet 4.7) — best cost-per-quality on structured-extraction
 * tasks per the Anthropic model docs.
 *
 * Required env vars:
 *   - `LINGUISTIC_FALLBACK_MODEL_ID` (string, optional — default
 *     above).
 *   - `LINGUISTIC_FALLBACK_PROMPT_VERSION` (int, optional — default
 *     1; gets recorded into `linguistic_attempts` per #64 so a
 *     bump triggers reprocess-on-failed per #66).
 *   - `LINGUISTIC_FALLBACK_PROMPT_TEMPLATE` (string, optional — see
 *     `DEFAULT_PROMPT_TEMPLATE` below). The template MUST contain
 *     the `{{TRANSCRIPT}}` placeholder.
 *
 * IAM: caller Lambda needs `bedrock:InvokeModel` on the configured
 * model ARN. Wired in `backend.ts` when the linguistic Lambda
 * consumer integration ships.
 *
 * Test seam: `opts.client` injects a stubbed BedrockRuntimeClient
 * so vitest never hits AWS.
 */

export const DEFAULT_FALLBACK_MODEL_ID = 'anthropic.claude-sonnet-4-7-20250115-v1:0';

export const DEFAULT_PROMPT_TEMPLATE = [
  'You are parsing a U.S. Air Force HFGCS Emergency Action Message (EAM)',
  'transcript. Extract the structured fields and call the `parsed_eam` tool',
  'with the result. Do not respond with prose; always call the tool.',
  '',
  'Transcript:',
  '"""',
  '{{TRANSCRIPT}}',
  '"""',
].join('\n');

/**
 * JSON Schema for the parsed-EAM tool output. Mirrors the Message
 * model in `amplify/data/models/message.ts` so a tool_use response
 * round-trips into a Message row without further mapping.
 */
export const PARSED_EAM_SCHEMA = {
  type: 'object',
  properties: {
    sender: { type: 'string', description: 'Originating callsign (e.g. SKYKING)' },
    receiver: { type: 'string', description: 'Destination callsign or "ALL STATIONS"' },
    type: {
      type: 'string',
      enum: [
        'BACKEND',
        'SKYKING',
        'ALLSTATIONS',
        'RADIOCHECK',
        'SKYMASTER',
        'SKYBIRD',
        'DISREGARDED',
        'OTHER',
      ],
      description: 'EAM message type from the curated CLAUDE.md enum',
    },
    body: {
      type: 'string',
      description: 'The decoded codeword groups (typically 6 letters in pairs)',
    },
    characterCount: { type: 'integer' },
    codewordCount: { type: 'integer' },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Model-reported confidence 0-1. 0.8+ auto-publishes; below flags for community review per CLAUDE.md.',
    },
  },
  required: ['type', 'confidence'],
} as const;

export interface ParsedEam {
  sender?: string;
  receiver?: string;
  type: string;
  body?: string;
  characterCount?: number;
  codewordCount?: number;
  confidence: number;
}

export interface FallbackResult {
  /** Tool-call result mapped to the parsed-EAM schema. */
  message: ParsedEam;
  /** Model that returned the result — recorded by #64 attempt log. */
  modelId: string;
  /** Prompt version recorded by #64 attempt log so re-runs are idempotent. */
  promptVersion: number;
  /** Whether the corrective retry was needed (observability surface). */
  retried: boolean;
}

export interface FallbackOpts {
  client?: BedrockRuntimeClient;
  modelId?: string;
  promptVersion?: number;
  promptTemplate?: string;
}

const PARSED_EAM_TOOL_NAME = 'parsed_eam';

function buildTools(): Tool[] {
  return [
    {
      toolSpec: {
        name: PARSED_EAM_TOOL_NAME,
        description: 'Return the structured EAM extracted from the transcript. Call exactly once.',
        inputSchema: {
          json: PARSED_EAM_SCHEMA as unknown as DocumentType,
        },
      },
    },
  ];
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function resolveOpts(opts: FallbackOpts): {
  client: BedrockRuntimeClient;
  modelId: string;
  promptVersion: number;
  promptTemplate: string;
} {
  const client = opts.client ?? new BedrockRuntimeClient({});
  const modelId =
    opts.modelId ?? process.env.LINGUISTIC_FALLBACK_MODEL_ID ?? DEFAULT_FALLBACK_MODEL_ID;
  const promptVersion = opts.promptVersion ?? readEnvInt('LINGUISTIC_FALLBACK_PROMPT_VERSION', 1);
  const promptTemplate =
    opts.promptTemplate ??
    process.env.LINGUISTIC_FALLBACK_PROMPT_TEMPLATE ??
    DEFAULT_PROMPT_TEMPLATE;
  if (!promptTemplate.includes('{{TRANSCRIPT}}')) {
    throw new Error('ai-fallback: prompt template must contain the {{TRANSCRIPT}} placeholder');
  }
  return { client, modelId, promptVersion, promptTemplate };
}

interface RequiredEam {
  type: string;
  confidence: number;
}

function isParsedEam(value: unknown): value is RequiredEam {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return false;
  if (typeof v.confidence !== 'number') return false;
  if (v.confidence < 0 || v.confidence > 1) return false;
  return true;
}

function extractToolUse(output: ConverseCommandOutput): unknown {
  const content = output.output?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if ('toolUse' in block && block.toolUse && block.toolUse.name === PARSED_EAM_TOOL_NAME) {
      return block.toolUse.input ?? null;
    }
  }
  return null;
}

function buildInput(modelId: string, messages: BedrockMessage[]): ConverseCommandInput {
  return {
    modelId,
    messages,
    toolConfig: {
      tools: buildTools(),
      toolChoice: { tool: { name: PARSED_EAM_TOOL_NAME } },
    },
  };
}

/**
 * Attempt a Bedrock-backed parse of `transcript`. Returns the
 * structured EAM + provenance on success, or `null` if Bedrock
 * fails to produce a schema-valid response after the corrective
 * retry. The caller (linguistic Lambda handler) flips
 * `parse_failed=true` on the Recording when `null` is returned.
 *
 * Throws only on programmer error (missing placeholder); Bedrock-
 * side failures surface as `null` so the SQS handler's retry +
 * DLQ path doesn't fire on every model hiccup.
 */
export async function tryBedrockFallback(
  transcript: string,
  opts: FallbackOpts = {},
): Promise<FallbackResult | null> {
  if (!transcript || transcript.trim() === '') return null;
  const { client, modelId, promptVersion, promptTemplate } = resolveOpts(opts);

  const userPrompt = promptTemplate.replace('{{TRANSCRIPT}}', transcript);
  const initialMessages: BedrockMessage[] = [{ role: 'user', content: [{ text: userPrompt }] }];

  let retried = false;
  let parsed: unknown = null;
  let firstResponse: ConverseCommandOutput | null = null;

  try {
    firstResponse = await client.send(new ConverseCommand(buildInput(modelId, initialMessages)));
    parsed = extractToolUse(firstResponse);
  } catch (err) {
    console.warn('ai-fallback: Bedrock Converse threw on first attempt', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!isParsedEam(parsed)) {
    // Corrective retry — append the previous attempt + a system-
    // shaped user message telling the model the response was off-
    // schema. One retry only; persistent failure -> null.
    retried = true;
    const correctiveMessages: BedrockMessage[] = [
      ...initialMessages,
      ...(firstResponse?.output?.message ? [firstResponse.output.message] : []),
      {
        role: 'user',
        content: [
          {
            text:
              'The previous response did not call the `parsed_eam` tool with a valid ' +
              'JSON object matching the schema. Required fields: `type` (string ' +
              'from the enum) and `confidence` (number 0-1). Call the tool now.',
          },
        ],
      },
    ];
    try {
      const retry = await client.send(new ConverseCommand(buildInput(modelId, correctiveMessages)));
      parsed = extractToolUse(retry);
    } catch (err) {
      console.warn('ai-fallback: Bedrock Converse threw on corrective retry', {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!isParsedEam(parsed)) {
      console.warn('ai-fallback: schema-invalid Bedrock response after retry; giving up', {
        modelId,
        promptVersion,
      });
      return null;
    }
  }

  return {
    message: parsed,
    modelId,
    promptVersion,
    retried,
  };
}
