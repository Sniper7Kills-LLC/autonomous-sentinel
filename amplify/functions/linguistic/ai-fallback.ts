import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  Message as BedrockMessage,
  Tool,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import { FALLBACK_SYSTEM_PROMPT } from './prompts/fallback-system-prompt';

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
 * Default model: `us.anthropic.claude-opus-4-8` — the cross-region
 * inference-profile id (Claude 4.x on Bedrock is not callable via the
 * bare foundation-model id; on-demand requires the profile). Opus 4.8
 * is the highest-quality tier, chosen for parse + rule-generation
 * accuracy on noisy ASR transcripts (#565); the fallback only fires on
 * a rules-engine miss, so volume is bounded. Verified available in
 * us-east-1 for this account; admin can swap to a cheaper model (Haiku
 * 4.5 / Sonnet 4.6) via the env var below to trade quality for cost.
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

export const DEFAULT_FALLBACK_MODEL_ID = 'us.anthropic.claude-opus-4-8';

// The default lives in a git-reviewable module (not the DB). The handler
// overrides it with the active `LinguisticPromptTemplate` body when one
// exists (admin-edited, version-bumped).
export const DEFAULT_PROMPT_TEMPLATE = FALLBACK_SYSTEM_PROMPT;

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
    rules: {
      type: 'array',
      description:
        'EXPECTED on nearly every call. Reusable per-component regex rules that let FUTURE similar transcripts be parsed by the cheap rules engine without calling you. Emit one per stable component you can anchor (preamble/sign-off tokens), preferring many small single-component rules over one whole-message rule. Score each confidence honestly — the gate auto-activates >=0.85 and queues the rest, so emit liberally rather than withholding. An empty array means the self-improving loop learned nothing; only return empty when the transcript truly shows no generalizable pattern.',
      items: {
        type: 'object',
        properties: {
          component: {
            type: 'string',
            enum: ['TYPE', 'SENDER', 'RECEIVER', 'BODY'],
            description:
              'TYPE detects the message type; SENDER/RECEIVER/BODY extract that one field.',
          },
          messageType: {
            type: 'string',
            description: 'For a TYPE rule: the type it assigns (from the enum above).',
          },
          appliesToType: {
            type: 'string',
            description:
              'For a SENDER/RECEIVER/BODY rule: the message type it extracts from. Omit to apply to all types.',
          },
          pattern: {
            type: 'string',
            description:
              'JavaScript-compatible regular expression. Use a NAMED capture group whose name matches the captureMap value (e.g. (?<sender>\\\\w+)).',
          },
          captureMap: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Map of regex named-group → field name (sender / receiver / body).',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Your confidence this rule is correct + general. Drives auto-activation.',
          },
        },
        required: ['component', 'pattern'],
      },
    },
  },
  required: ['type', 'confidence'],
} as const;

/** A per-component rule the model proposes for the LinguisticRule table (#544). */
export interface ProposedRule {
  component: 'TYPE' | 'SENDER' | 'RECEIVER' | 'BODY';
  pattern: string;
  messageType?: string;
  appliesToType?: string;
  captureMap?: Record<string, string>;
  confidence?: number;
}

const RULE_COMPONENTS = new Set(['TYPE', 'SENDER', 'RECEIVER', 'BODY']);
/**
 * Max length of an AI-proposed regex. A defensive cap against a
 * pathological (ReDoS-prone) pattern reaching the engine — real EAM
 * component patterns are short. Over-length patterns are dropped.
 */
const MAX_RULE_PATTERN_LENGTH = 500;

/**
 * Validate + clean the model's proposed rules. Drops any whose pattern
 * isn't a compilable regex or whose component is unknown — a malformed
 * AI rule must never reach the engine.
 */
export function sanitizeProposedRules(raw: unknown): ProposedRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.component !== 'string' || !RULE_COMPONENTS.has(o.component)) continue;
    if (
      typeof o.pattern !== 'string' ||
      o.pattern.length === 0 ||
      o.pattern.length > MAX_RULE_PATTERN_LENGTH
    ) {
      continue;
    }
    try {
      new RegExp(o.pattern);
    } catch {
      continue;
    }
    const rule: ProposedRule = {
      component: o.component as ProposedRule['component'],
      pattern: o.pattern,
    };
    if (typeof o.messageType === 'string') rule.messageType = o.messageType;
    if (typeof o.appliesToType === 'string' && o.appliesToType)
      rule.appliesToType = o.appliesToType;
    if (o.captureMap && typeof o.captureMap === 'object') {
      rule.captureMap = o.captureMap as Record<string, string>;
    }
    if (typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1) {
      rule.confidence = o.confidence;
    }
    out.push(rule);
  }
  return out;
}

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
  /** Per-component rules the model proposed (#544) — already sanitized. */
  rules: ProposedRule[];
}

export interface FallbackOpts {
  client?: BedrockRuntimeClient;
  modelId?: string;
  promptVersion?: number;
  promptTemplate?: string;
  /**
   * Dynamic context appended to the rendered prompt at send time (#544b)
   * — the failed rule-engine attempt + the current ruleset, so the model
   * refines existing rules instead of only generating fresh ones. NOT
   * part of the prompt-version hash (it changes every invocation).
   */
  context?: string;
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

/**
 * Render the fallback prompt (template + transcript) without invoking
 * Bedrock, plus the resolved model/version. The handler hashes the
 * rendered string for the #64 attempt log so an SQS redrive of the same
 * recording can `shouldSkip` the (paid) Bedrock call.
 */
export function renderFallbackPrompt(
  transcript: string,
  opts: FallbackOpts = {},
): { rendered: string; promptVersion: number; modelId: string } {
  const { modelId, promptVersion, promptTemplate } = resolveOpts(opts);
  return {
    rendered: promptTemplate.replace('{{TRANSCRIPT}}', transcript),
    promptVersion,
    modelId,
  };
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

  const rendered = promptTemplate.replace('{{TRANSCRIPT}}', transcript);
  // Append the dynamic context (failed attempt + ruleset, #544b) after
  // the rendered prompt — kept out of the prompt-version hash upstream.
  const userPrompt = opts.context ? `${rendered}\n\n${opts.context}` : rendered;
  const initialMessages: BedrockMessage[] = [{ role: 'user', content: [{ text: userPrompt }] }];

  let retried = false;
  let parsed: unknown = null;
  let firstResponse: ConverseCommandOutput | null = null;

  // First attempt, with ONE retry on a transient Converse throw (#577).
  // Bedrock intermittently throws "Bedrock is unable to process your
  // request." / throttling on the first call; a single retry usually
  // clears it. Without this the transcript fell back to inline type-only
  // despite being perfectly parseable.
  try {
    firstResponse = await client.send(new ConverseCommand(buildInput(modelId, initialMessages)));
  } catch (err) {
    console.warn('ai-fallback: Bedrock Converse threw on first attempt; retrying once', {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      firstResponse = await client.send(new ConverseCommand(buildInput(modelId, initialMessages)));
    } catch (err2) {
      console.warn('ai-fallback: Bedrock Converse threw on transient retry; giving up', {
        modelId,
        error: err2 instanceof Error ? err2.message : String(err2),
      });
      return null;
    }
  }
  parsed = extractToolUse(firstResponse);

  if (!isParsedEam(parsed)) {
    // Corrective retry (#577) — re-ask as a FRESH single user turn with an
    // appended instruction. We deliberately do NOT append the prior
    // assistant `tool_use` turn: the Converse API requires a following
    // `tool_result` block for any `tool_use`, so a plain-text correction
    // is rejected ("tool_use ids were found without tool_result blocks")
    // and the old retry ALWAYS failed. A fresh ask sidesteps the coupling.
    retried = true;
    const correctiveMessages: BedrockMessage[] = [
      {
        role: 'user',
        content: [
          {
            text:
              `${userPrompt}\n\n` +
              'IMPORTANT: your previous response did not call the `parsed_eam` tool ' +
              'with a valid JSON object. Call `parsed_eam` now with at least `type` ' +
              '(a string from the enum) and `confidence` (a number 0-1).',
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
    rules: sanitizeProposedRules((parsed as { rules?: unknown }).rules),
  };
}
