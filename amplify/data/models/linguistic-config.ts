import { a } from '@aws-amplify/backend';

/**
 * LinguisticConfig — runtime config for the Linguistic Logic Lambda (#43).
 *
 * Keyed records (e.g. `SKYKING_RULES`, `CONFIDENCE_THRESHOLD_SKYKING`,
 * `*_PROMPT_VERSION`). The Lambda reads at each invocation (hot-reload);
 * admins edit via the admin UI. Per CLAUDE.md, bumping a `*_PROMPT_VERSION`
 * key triggers a reprocess of `transcriptionFailed=true` recordings only —
 * the reprocess trigger Lambda is phase 3 work; this issue just lands the
 * storage.
 *
 * Revision history is captured by AuditLog (#38) entries with action
 * `LINGUISTIC_CONFIG_UPDATE` — no per-key history table.
 *
 * Deferred:
 *   - Server-side hook that emits an AuditLog entry on every update.
 *   - Reprocess-on-bump trigger Lambda.
 */
export const LinguisticConfig = a
  .model({
    key: a.string().required(),
    value: a.json().required(),
    promptVersion: a.integer(),
    activeAt: a.datetime(),
    createdById: a.id(),
    notes: a.string(),
  })
  .identifier(['key'])
  .secondaryIndexes((i) => [i('promptVersion')])
  .authorization((allow) => [
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
