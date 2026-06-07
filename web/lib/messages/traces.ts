'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Display shapes for the per-run `LinguisticTrace` rows (#744) consumed by
 * the diagnostics popout (#745). Read access is gated to admin / moderator /
 * diagnostics server-side; this layer only assembles data.
 *
 * The `a.json()` columns arrive either pre-parsed (objects) or as JSON
 * strings depending on transport, so each is normalized through `parseJson`.
 */

export interface TraceRuleEvaluation {
  ruleId: string;
  component: string | null;
  messageType: string | null;
  appliesToType: string | null;
  pattern: string;
  confidence: number | null;
  matched: boolean;
  matchedText: string | null;
  captures: Record<string, string>;
}

export interface DisplayTrace {
  id: string;
  recordingId: string;
  runAt: string;
  triggerBackend: string | null;
  transcriptSnapshot: string | null;
  rulesEvaluated: TraceRuleEvaluation[];
  rulesOutcome: unknown;
  bedrockInvoked: boolean;
  bedrockModelId: string | null;
  bedrockPromptVersion: number | null;
  bedrockPromptHash: string | null;
  bedrockRenderedPrompt: string | null;
  bedrockRawResponse: unknown;
  bedrockParsed: unknown;
  bedrockProposedRules: unknown;
  finalResult: unknown;
  attemptSuccess: boolean | null;
  resultHash: string | null;
  promptHash: string | null;
  overflowKeys: { renderedPrompt?: string; rawResponse?: string };
  truncated: boolean;
}

type RawTrace = Record<string, unknown>;
type RawListResult = {
  data?: RawTrace[] | null;
  nextToken?: string | null;
  errors?: { message: string }[] | null;
};

/** Normalize an `a.json()` column that may be a string or an already-parsed value. */
function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toRuleEvaluations(v: unknown): TraceRuleEvaluation[] {
  const parsed = parseJson(v);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const caps = o.captures;
    return {
      ruleId: asString(o.ruleId) ?? '',
      component: asString(o.component),
      messageType: asString(o.messageType),
      appliesToType: asString(o.appliesToType),
      pattern: asString(o.pattern) ?? '',
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
      matched: Boolean(o.matched),
      matchedText: asString(o.matchedText),
      captures:
        caps && typeof caps === 'object' && !Array.isArray(caps)
          ? (caps as Record<string, string>)
          : {},
    };
  });
}

function toOverflowKeys(v: unknown): DisplayTrace['overflowKeys'] {
  const parsed = parseJson(v);
  if (!parsed || typeof parsed !== 'object') return {};
  const o = parsed as Record<string, unknown>;
  const out: DisplayTrace['overflowKeys'] = {};
  if (typeof o.renderedPrompt === 'string') out.renderedPrompt = o.renderedPrompt;
  if (typeof o.rawResponse === 'string') out.rawResponse = o.rawResponse;
  return out;
}

export function toDisplayTrace(r: RawTrace): DisplayTrace {
  return {
    id: asString(r.id) ?? '',
    recordingId: asString(r.recordingId) ?? '',
    runAt: asString(r.runAt) ?? '',
    triggerBackend: asString(r.triggerBackend),
    transcriptSnapshot: asString(r.transcriptSnapshot),
    rulesEvaluated: toRuleEvaluations(r.rulesEvaluated),
    rulesOutcome: parseJson(r.rulesOutcome),
    bedrockInvoked: Boolean(r.bedrockInvoked),
    bedrockModelId: asString(r.bedrockModelId),
    bedrockPromptVersion:
      typeof r.bedrockPromptVersion === 'number' ? r.bedrockPromptVersion : null,
    bedrockPromptHash: asString(r.bedrockPromptHash),
    bedrockRenderedPrompt: asString(r.bedrockRenderedPrompt),
    bedrockRawResponse: parseJson(r.bedrockRawResponse),
    bedrockParsed: parseJson(r.bedrockParsed),
    bedrockProposedRules: parseJson(r.bedrockProposedRules),
    finalResult: parseJson(r.finalResult),
    attemptSuccess: typeof r.attemptSuccess === 'boolean' ? r.attemptSuccess : null,
    resultHash: asString(r.resultHash),
    promptHash: asString(r.promptHash),
    overflowKeys: toOverflowKeys(r.overflowKeys),
    truncated: Boolean(r.truncated),
  };
}

/**
 * List every `LinguisticTrace` for a recording, newest run first. Prefers
 * the generated `recordingId`+`runAt` GSI query; falls back to a filtered
 * list when the generated accessor isn't present in the client build.
 * Throws on a GraphQL error so the caller can surface it (the panel treats
 * a failure as "no traces / not authorized").
 */
export async function listTracesForRecording(recordingId: string): Promise<DisplayTrace[]> {
  const client = getDataClient();
  const authMode = await resolveAuthMode();
  const models = client.models as Record<string, unknown>;

  const byIndex = (
    client.queries as unknown as {
      listLinguisticTraceByRecordingId?: (
        input: { recordingId: string },
        opts: { authMode: typeof authMode },
      ) => Promise<RawListResult>;
    }
  ).listLinguisticTraceByRecordingId;

  let raw: RawListResult;
  if (typeof byIndex === 'function') {
    raw = await byIndex({ recordingId }, { authMode });
  } else {
    const model = models.LinguisticTrace as
      | { list?: (input: Record<string, unknown>) => Promise<RawListResult> }
      | undefined;
    if (!model?.list) return [];
    raw = await model.list({ filter: { recordingId: { eq: recordingId } }, authMode });
  }

  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  return (raw.data ?? []).map(toDisplayTrace).sort((a, b) => b.runAt.localeCompare(a.runAt));
}

/**
 * Fetch a spilled trace blob (#749) from its S3 `diagnostics/` key. When a
 * trace is too large for a single DynamoDB row the linguistic Lambda offloads
 * the rendered prompt + raw response to S3 and stores the keys in
 * `overflowKeys`; the popout calls this on demand to display them. Read is
 * authorized by the `diagnostics/*` storage rule (admin/moderator/diagnostics)
 * — a signed URL is minted, then fetched as text.
 */
export async function fetchTraceOverflow(key: string): Promise<string> {
  const { getUrl } = await import('aws-amplify/storage');
  const { url } = await getUrl({ path: key });
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Failed to fetch diagnostics blob (${res.status})`);
  }
  return res.text();
}
