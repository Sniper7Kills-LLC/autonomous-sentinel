'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { FALLBACK_SYSTEM_PROMPT } from './fallbackPrompt';

/**
 * Admin data-access layer for the Linguistic Logic config surfaces
 * (#546): LinguisticPromptTemplate CRUD + LinguisticRule review queue.
 *
 * Both models are admin-gated server-side (`allow.groups(['admin'])`),
 * so every call here uses the `userPool` auth mode — the default
 * (guest/iam) auth returns Unauthorized. Mirrors the pattern in
 * `web/lib/uploads/reprocess.ts`.
 *
 * Scope note: the model docstrings describe a deferred *atomic*
 * activation mutation (TransactWriteItems flip) and a *version-bumping*
 * create mutation; neither exists yet. Until they ship, the helpers
 * here approximate both client-side with the auto-generated
 * create/update/delete operations:
 *   - `activateTemplate` deactivates the prior active row(s), then
 *     activates the chosen one (two sequential updates — NOT atomic; a
 *     mid-flight failure can leave zero or two active rows; the Lambda
 *     tolerates multi-active by picking version-desc and logging a warn).
 *   - `saveNewTemplateVersion` computes `max(version)+1` client-side
 *     then `create`s (subject to a lost-update race between concurrent
 *     admins; the deferred mutation closes it with a conditional write).
 * These approximations are called out in the admin UI copy and the PR.
 */

export const ACTIVE_PROMPT_ID = 'linguistic-parse-bedrock';

/** Confidence at/above which AI-emitted rules auto-activate (#543). */
export const RULE_AUTO_ACTIVATE_THRESHOLD = 0.85;

export { FALLBACK_SYSTEM_PROMPT };

export type DisplayTemplate = {
  id: string;
  promptId: string;
  version: number;
  body: string;
  isActive: boolean;
  notes: string | null;
  createdBy: string | null;
  createdAt: string | null;
};

export type AdminRule = {
  id: string;
  component: 'TYPE' | 'SENDER' | 'RECEIVER' | 'BODY' | null;
  pattern: string;
  confidence: number | null;
  enabled: boolean;
  messageType: string;
  appliesToType: string | null;
  priority: number | null;
  notes: string | null;
};

type RawTemplate = {
  id: string;
  promptId?: string | null;
  version?: number | null;
  body?: string | null;
  isActive?: boolean | null;
  notes?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
};

type RawRule = {
  id: string;
  component?: string | null;
  pattern?: string | null;
  confidence?: number | null;
  enabled?: boolean | null;
  messageType?: string | null;
  appliesToType?: string | null;
  priority?: number | null;
  notes?: string | null;
};

type RawListResult<T> = { data?: T[] | null; errors?: { message: string }[] | null };
type RawMutResult<T> = { data?: T | null; errors?: { message: string }[] | null };

type ModelOps<T> = {
  list?: (input?: Record<string, unknown>) => Promise<RawListResult<T>>;
  create?: (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawMutResult<T>>;
  update?: (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawMutResult<T>>;
  delete?: (
    input: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<RawMutResult<T>>;
};

const USER_POOL = { authMode: 'userPool' as const };

const COMPONENTS = ['TYPE', 'SENDER', 'RECEIVER', 'BODY'] as const;

function toComponent(v: unknown): AdminRule['component'] {
  return typeof v === 'string' && (COMPONENTS as readonly string[]).includes(v)
    ? (v as AdminRule['component'])
    : null;
}

function modelOps<T>(name: string): ModelOps<T> {
  const client = getDataClient();
  const model = (client.models as Record<string, unknown>)[name] as ModelOps<T> | undefined;
  if (!model) {
    throw new Error(`${name} model is not available on the data client.`);
  }
  return model;
}

function throwOnErrors(errors: { message: string }[] | null | undefined, op: string): void {
  if (errors && errors.length > 0) {
    throw new Error(`${op} failed: ${errors.map((e) => e.message).join('; ')}`);
  }
}

function toTemplate(r: RawTemplate): DisplayTemplate {
  return {
    id: r.id,
    promptId: r.promptId ?? '',
    version: typeof r.version === 'number' ? r.version : 0,
    body: r.body ?? '',
    isActive: Boolean(r.isActive),
    notes: r.notes ?? null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt ?? null,
  };
}

function toRule(r: RawRule): AdminRule {
  return {
    id: r.id,
    component: toComponent(r.component),
    pattern: r.pattern ?? '',
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    enabled: Boolean(r.enabled),
    messageType: r.messageType ?? '',
    appliesToType: r.appliesToType ?? null,
    priority: typeof r.priority === 'number' ? r.priority : null,
    notes: r.notes ?? null,
  };
}

/**
 * List every prompt template for `ACTIVE_PROMPT_ID`, newest version
 * first. Admin-gated read; non-admins get an Unauthorized error from
 * AppSync (surfaced to the caller).
 */
export async function listPromptTemplates(): Promise<DisplayTemplate[]> {
  const model = modelOps<RawTemplate>('LinguisticPromptTemplate');
  if (!model.list) return [];
  const res = await model.list({
    filter: { promptId: { eq: ACTIVE_PROMPT_ID } },
    ...USER_POOL,
  });
  throwOnErrors(res.errors, 'listPromptTemplates');
  return (res.data ?? []).map(toTemplate).sort((a, b) => b.version - a.version);
}

/**
 * Save a new prompt-template version. Computes `max(version)+1` from the
 * supplied existing list (the caller already holds it), validates the
 * `{{TRANSCRIPT}}` placeholder contract, and `create`s a new inactive
 * row. NON-ATOMIC version assignment — see module docstring.
 */
export async function saveNewTemplateVersion(input: {
  body: string;
  notes?: string | null;
  existing: readonly DisplayTemplate[];
}): Promise<DisplayTemplate> {
  if (!input.body.includes('{{TRANSCRIPT}}')) {
    throw new Error('Prompt body must contain the {{TRANSCRIPT}} placeholder.');
  }
  const maxVersion = input.existing.reduce((m, t) => Math.max(m, t.version), 0);
  const nextVersion = maxVersion + 1;
  const model = modelOps<RawTemplate>('LinguisticPromptTemplate');
  if (!model.create) throw new Error('LinguisticPromptTemplate.create is unavailable.');
  const res = await model.create(
    {
      promptId: ACTIVE_PROMPT_ID,
      version: nextVersion,
      body: input.body,
      isActive: false,
      notes: input.notes ?? null,
    },
    USER_POOL,
  );
  throwOnErrors(res.errors, 'saveNewTemplateVersion');
  if (!res.data) throw new Error('saveNewTemplateVersion returned no row.');
  return toTemplate(res.data);
}

/**
 * Activate one template version for `ACTIVE_PROMPT_ID`: deactivate every
 * other active row, then activate the target. NON-ATOMIC (two-phase
 * client-side flip) — see module docstring.
 */
export async function activateTemplate(
  targetId: string,
  templates: readonly DisplayTemplate[],
): Promise<void> {
  const model = modelOps<RawTemplate>('LinguisticPromptTemplate');
  if (!model.update) throw new Error('LinguisticPromptTemplate.update is unavailable.');
  const update = model.update;
  for (const t of templates) {
    if (t.id !== targetId && t.isActive) {
      const res = await update({ id: t.id, isActive: false }, USER_POOL);
      throwOnErrors(res.errors, 'activateTemplate(deactivate)');
    }
  }
  const res = await update({ id: targetId, isActive: true }, USER_POOL);
  throwOnErrors(res.errors, 'activateTemplate(activate)');
}

/** List every LinguisticRule, highest priority first. Admin-gated read. */
export async function listRules(): Promise<AdminRule[]> {
  const model = modelOps<RawRule>('LinguisticRule');
  if (!model.list) return [];
  const res = await model.list(USER_POOL);
  throwOnErrors(res.errors, 'listRules');
  return (res.data ?? []).map(toRule).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/** Toggle a rule's `enabled` flag (activate / deactivate). Admin-gated. */
export async function setRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
  const model = modelOps<RawRule>('LinguisticRule');
  if (!model.update) throw new Error('LinguisticRule.update is unavailable.');
  const res = await model.update({ id: ruleId, enabled }, USER_POOL);
  throwOnErrors(res.errors, 'setRuleEnabled');
}

/** Hard-delete a bad rule. Admin-gated. */
export async function deleteRule(ruleId: string): Promise<void> {
  const model = modelOps<RawRule>('LinguisticRule');
  if (!model.delete) throw new Error('LinguisticRule.delete is unavailable.');
  const res = await model.delete({ id: ruleId }, USER_POOL);
  throwOnErrors(res.errors, 'deleteRule');
}
