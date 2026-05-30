'use client';

import { getDataClient } from '@/lib/amplifyClient';
import { resolveAuthMode } from '@/lib/auth/mode';

/**
 * Display shape of a `LinguisticRule` row for the moderator/admin-only
 * debug panel (#561).
 *
 * IMPORTANT: rules have NO per-message foreign key, so this can only
 * ever surface rules whose `messageType` matches the Message's type —
 * it is NOT a record of which rule actually parsed a given Message. The
 * UI labels the section accordingly.
 */
export type DisplayRule = {
  id: string;
  component: 'TYPE' | 'SENDER' | 'RECEIVER' | 'BODY' | null;
  pattern: string;
  confidence: number | null;
  enabled: boolean;
  messageType: string;
  appliesToType: string | null;
  priority: number | null;
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
};

type RawRuleListResult = {
  data?: RawRule[] | null;
  errors?: { message: string }[] | null;
};

const COMPONENTS = ['TYPE', 'SENDER', 'RECEIVER', 'BODY'] as const;

function toComponent(v: unknown): DisplayRule['component'] {
  return typeof v === 'string' && (COMPONENTS as readonly string[]).includes(v)
    ? (v as DisplayRule['component'])
    : null;
}

function toDisplay(r: RawRule): DisplayRule {
  return {
    id: r.id,
    component: toComponent(r.component),
    pattern: r.pattern ?? '',
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    enabled: Boolean(r.enabled),
    messageType: r.messageType ?? '',
    appliesToType: r.appliesToType ?? null,
    priority: typeof r.priority === 'number' ? r.priority : null,
  };
}

/**
 * Best-effort list of LinguisticRules relevant to a message type.
 *
 * Matches rules whose `messageType` equals the given type. The model is
 * admin-only (CRUD restricted to the `admin` group), so this only
 * resolves for callers in that group; non-admins (incl. moderators)
 * may get an authorization error — the panel treats any failure as an
 * empty list and shows a note rather than blocking the rest of the
 * debug view.
 */
export async function listRulesForType(messageType: string): Promise<DisplayRule[]> {
  const client = getDataClient();
  const model = (client.models as Record<string, unknown>).LinguisticRule as
    | { list?: (input: Record<string, unknown>) => Promise<RawRuleListResult> }
    | undefined;
  // Generated client may not expose the model in every build context;
  // bail gracefully so the rest of the debug panel still renders.
  if (!model?.list) return [];
  const listFn = model.list;
  const authMode = await resolveAuthMode();
  const raw = await listFn({
    filter: { messageType: { eq: messageType } },
    authMode,
  });
  if (raw.errors?.length) {
    throw new Error(raw.errors.map((e) => e.message).join('; '));
  }
  return (raw.data ?? []).map(toDisplay);
}
