import { a } from '@aws-amplify/backend';

/**
 * LinguisticRule — admin-managed regex rules consumed by the
 * Linguistic Logic Lambda's hybrid parser (#62).
 *
 * The Lambda loads enabled rules at cold start, caches them with a
 * 60-second TTL (per the engine helper), and runs the regex set in
 * descending `priority` order on each transcript. First match wins;
 * captureMap maps regex named-groups to Message fields (sender,
 * receiver, body, type). Rule miss → AI fallback (#63).
 *
 * Hot-reload semantics: admin updates a rule via the auto-generated
 * `updateLinguisticRule` mutation; the engine refreshes the cache
 * on its next TTL expiry OR on prompt_version bump (#66). Effect
 * within 60 s without a Lambda redeploy.
 *
 * Authz:
 *   - admin group: full CRUD (the only authz layer that mutates).
 *   - linguistic Lambda: schema-level `allow.resource(...)` grant
 *     for read-only access. Wired in `amplify/data/resource.ts`
 *     alongside the model registration.
 *
 * Deferred:
 *   - Per-rule `linguisticAttempts` denormalisation (#64 audit
 *     trail — separate model + write).
 *   - Per-rule confidence threshold override (#65 — currently
 *     global threshold from LinguisticConfig).
 */
export const LinguisticRule = a
  .model({
    /**
     * Regex source string. Compiled once per cache load — the
     * engine catches `SyntaxError` and reports it as a rule-
     * level failure so one bad rule doesn't break the whole
     * parser.
     */
    pattern: a.string().required(),
    /**
     * MessageType enum from CLAUDE.md domain model: BACKEND /
     * SKYKING / ALLSTATIONS / RADIOCHECK / SKYMASTER / SKYBIRD /
     * DISREGARDED / OTHER. Stored as a string so future enum
     * additions don't require a model migration.
     */
    messageType: a.string().required(),
    /**
     * Capture-group → Message-field map, JSON object. Example:
     * `{ "sender": "sender", "receiver": "receiver", "body": "body" }`
     * Engine reads `match.groups[mapKey]` and assigns to
     * `parsedMessage[mapValue]`.
     */
    captureMap: a.json().required(),
    /**
     * Higher priority runs first. Ties resolved by `ruleId` lex
     * order so the iteration is deterministic.
     */
    priority: a.integer().required(),
    /**
     * Toggle for admin pause without delete. Engine skips disabled
     * rules at cache-load time.
     */
    enabled: a.boolean().default(true),
    /**
     * Prompt-version bump invalidates the engine cache (#66). Same
     * column doubles as a human change-log marker — admin bumps
     * when reshaping the regex.
     */
    promptVersion: a.integer().default(1),
    /**
     * Free-form admin notes — what the rule matches, why this
     * priority, etc.
     */
    notes: a.string(),
  })
  // No secondary index. Rule count is bounded by what an admin
  // hand-curates (dozens, not thousands), so the engine cold-load
  // Scans the table + filters `enabled=true` in-memory. Cheaper to
  // operate than maintaining a GSI on a near-static table. Switch
  // to a sparse GSI on a messageType-derived attribute if/when the
  // rule set ever outgrows single-page Scans.
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);
