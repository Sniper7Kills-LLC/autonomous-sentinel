import { a } from '@aws-amplify/backend';

/**
 * PlaybackConfig — admin-tunable per-IP playback rate-limit knobs (#114).
 *
 * Single config row keyed by `key` (singleton, e.g. `"default"`). Per
 * CLAUDE.md → Storage / retention: "Hard rate-limit per IP, admin-tunable
 * in admin UI." This model is the storage + the admin tuning surface for
 * those limits. The signed-URL / CloudFront edge enforcement that READS
 * this config lives in the playback pipeline (phase 6 — #205 / WAF /
 * Lambda@Edge) and is out of scope here.
 *
 * Fields (defaults are CLAUDE.md-aligned starting points; all admin-tunable):
 *   - `requestsPerMinute`   — per-IP signed-URL requests/minute (default 60).
 *   - `bytesPerHour`        — per-IP bytes served/hour (default 1 GiB).
 *   - `signedUrlTtlSeconds` — playback signed-URL lifetime (default 300).
 *   - `notes`               — optional operator note.
 *
 * Kept STANDALONE — no relations, no authz changes to other models — to
 * avoid CFN dependency cycles. Mirrors `ReputationConfig` / `LinguisticConfig`.
 *
 * Revision history is captured by AuditLog (#38) entries — no per-key
 * history table. Authz is admin-only (these are admin knobs).
 *
 * Deferred (need playback counters that don't exist yet — #91 / #205):
 *   - Stats dashboards: most-played audio, top-playing users, throttle-
 *     event counts, bytes-served sparkline. The admin UI ships a
 *     placeholder until those counters land.
 */
export const PlaybackConfig = a
  .model({
    key: a.string().required(),
    requestsPerMinute: a.integer().default(60),
    bytesPerHour: a.float().default(1073741824),
    signedUrlTtlSeconds: a.integer().default(300),
    notes: a.string(),
  })
  .identifier(['key'])
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);
