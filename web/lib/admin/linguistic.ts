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
 * Prompt-template activation + version creation route through the
 * server-side atomic mutations (#572): `activateTemplate` calls
 * `activatePromptTemplate` (a single TransactWriteItems flip — exactly
 * one active row, no two-phase race) and `saveNewTemplateVersion` calls
 * `savePromptTemplateVersion` (a conditional create that allocates the
 * next version atomically). Both are admin-gated server-side; errors
 * propagate to the UI so a failed call never looks like a success.
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

type MutationFn<T> = (
  input: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<RawMutResult<T>>;

function mutationFn<T>(name: string): MutationFn<T> {
  const client = getDataClient();
  const mutations = (client as { mutations?: Record<string, unknown> }).mutations ?? {};
  const fn = mutations[name] as MutationFn<T> | undefined;
  if (!fn) {
    throw new Error(`${name} mutation is not available on the data client.`);
  }
  return fn;
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
 * Save a new prompt-template version via the atomic
 * `savePromptTemplateVersion` mutation (#572): the server allocates the
 * next `version` under a conditional write (no client-side `max+1`
 * race) and creates an inactive row. The `{{TRANSCRIPT}}` placeholder
 * is validated client-side for fast feedback and re-validated
 * server-side. Returns the created row.
 */
export async function saveNewTemplateVersion(input: {
  body: string;
  notes?: string | null;
}): Promise<DisplayTemplate> {
  if (!input.body.includes('{{TRANSCRIPT}}')) {
    throw new Error('Prompt body must contain the {{TRANSCRIPT}} placeholder.');
  }
  const save = mutationFn<RawTemplate>('savePromptTemplateVersion');
  const res = await save(
    {
      promptId: ACTIVE_PROMPT_ID,
      body: input.body,
      notes: input.notes ?? null,
    },
    USER_POOL,
  );
  throwOnErrors(res.errors, 'saveNewTemplateVersion');
  if (!res.data) throw new Error('saveNewTemplateVersion returned no row.');
  return toTemplate(res.data);
}

/**
 * Activate one template version for `ACTIVE_PROMPT_ID` via the atomic
 * `activatePromptTemplate` mutation (#572): a single server-side
 * TransactWriteItems flips the target active + every other inactive, so
 * the table always settles on exactly one active row (no two-phase
 * client race). Returns the activated row.
 */
export async function activateTemplate(targetId: string): Promise<DisplayTemplate> {
  const activate = mutationFn<RawTemplate>('activatePromptTemplate');
  const res = await activate({ id: targetId }, USER_POOL);
  throwOnErrors(res.errors, 'activateTemplate');
  if (!res.data) throw new Error('activateTemplate returned no row.');
  return toTemplate(res.data);
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

/* ------------------------------------------------------------------ *
 * LinguisticConfig keyed-row helpers (#110)
 *
 * The thresholds + schemas editors persist into the existing
 * `LinguisticConfig` model (`key` identifier, `value` json). Each
 * surface owns a single row (`key="thresholds"` / `key="schemas"`).
 * `value` round-trips as a plain object; AppSync stores it as JSON.
 *
 * Deferred (out of scope for #110):
 *   - Server-side AuditLog diff on each update (#479).
 *   - Atomic prompt-version activation (#572).
 * ------------------------------------------------------------------ */

type RawConfig = {
  key: string;
  value?: unknown;
  promptVersion?: number | null;
  notes?: string | null;
};

/**
 * Read one LinguisticConfig row's `value` blob by key. Returns
 * `undefined` when the row does not exist yet (first-time editing), so
 * callers fall back to defaults. Admin-gated read.
 */
export async function getLinguisticConfig(key: string): Promise<unknown> {
  const model = modelOps<RawConfig>('LinguisticConfig');
  const get = (
    model as {
      get?: (
        input: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<RawMutResult<RawConfig>>;
    }
  ).get;
  if (!get) throw new Error('LinguisticConfig.get is unavailable.');
  // authMode is the SECOND arg to model.get (identifier first). Passing it
  // inside the identifier object silently drops it → the read falls back to
  // the client-default auth and 401s against the admin-only model.
  const res = await get({ key }, USER_POOL);
  throwOnErrors(res.errors, `getLinguisticConfig(${key})`);
  return res.data?.value;
}

/**
 * Create-or-update one LinguisticConfig row. Tries `update` first
 * (the row usually exists); on a "not found"-shaped failure or when
 * `update` is unavailable, falls back to `create`. Admin-gated write.
 *
 * NOTE: non-atomic create-or-update (a concurrent first write could
 * race), acceptable for a single-admin config surface; the audit-log
 * diff that would make this observable is deferred to #479.
 */
export async function upsertLinguisticConfig(
  key: string,
  value: unknown,
  notes?: string | null,
): Promise<void> {
  const model = modelOps<RawConfig>('LinguisticConfig');
  const payload: Record<string, unknown> = { key, value };
  if (notes !== undefined) payload.notes = notes;

  if (model.update) {
    const res = await model.update(payload, USER_POOL);
    if (!res.errors || res.errors.length === 0) return;
    // Row may not exist yet — fall through to create below.
  }
  if (!model.create) {
    throw new Error('LinguisticConfig.create is unavailable.');
  }
  const res = await model.create(payload, USER_POOL);
  throwOnErrors(res.errors, `upsertLinguisticConfig(${key})`);
}
