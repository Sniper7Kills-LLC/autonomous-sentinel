import { a } from '@aws-amplify/backend';

/**
 * ReputationConfig — admin-tunable coefficients for the vote-weight /
 * reputation formula (#117).
 *
 * Single config row keyed by `key` (singleton, e.g. `"default"`). Stores
 * every number in the CLAUDE.md → Domain model → Vote formula so the
 * weights can be tuned from the admin UI without a code change:
 *
 *   weight = base
 *          + perValidatedSubmission * min(validatedSubmissions, validatedCap)
 *          + perAcceptedCorrection  * min(acceptedCorrections,  correctionCap)
 *          + (role === 'moderator' ? moderatorBonus : 0)
 *          + (role === 'admin'     ? adminBonus     : 0)
 *   weight = min(weight, netWeightCap)
 *
 * Defaults match CLAUDE.md: base 1, +0.1/validated submission (cap +4),
 * +0.5/accepted correction (cap +5), +1 mod, +2 admin, net cap 5x. The
 * `quorum` + `confidenceThreshold` knobs are surfaced here for reputation
 * context (issue Approach) — confidence threshold also appears in #110.
 *
 * The Lambda that APPLIES this formula to Reputation rows on publish /
 * accept is #480 — out of scope here; this model is the storage + the
 * admin tuning surface only.
 *
 * Revision history is captured by AuditLog (#38) entries — no per-key
 * history table. Authz is admin-only (these are admin knobs).
 */
export const ReputationConfig = a
  .model({
    key: a.string().required(),
    base: a.float().default(1),
    perValidatedSubmission: a.float().default(0.1),
    validatedCap: a.integer().default(4),
    perAcceptedCorrection: a.float().default(0.5),
    correctionCap: a.integer().default(5),
    moderatorBonus: a.float().default(1),
    adminBonus: a.float().default(2),
    netWeightCap: a.float().default(5),
    quorum: a.float().default(2),
    confidenceThreshold: a.float().default(0.8),
    updatedById: a.id(),
    notes: a.string(),
  })
  .identifier(['key'])
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);
