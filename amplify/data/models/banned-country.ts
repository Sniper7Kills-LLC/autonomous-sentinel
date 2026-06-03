import { a } from '@aws-amplify/backend';

/**
 * BannedCountry — admin-managed list of blocked ISO-3166-1 alpha-2
 * country codes fed into the WAF geo-match rules by the `wafSync`
 * Lambda (phase 9, issues #199/#201).
 *
 * One row per UPPERCASE alpha-2 code (`iso2` is the identifier). The
 * `scope` enum decides the block surface: write-only (default — the
 * sync Lambda treats a missing/anything-not-`read_write` value as
 * `write`, so blocked-country visitors can still browse the public
 * archive) vs `read_write` (full read+write block).
 *
 * Admin-only for everything — ban lists are sensitive, so there is NO
 * guest/public read.
 */
export const BannedCountry = a
  .model({
    iso2: a.string().required(),
    scope: a.enum(['write', 'read_write']),
    reason: a.string(),
    createdBy: a.string(),
  })
  .identifier(['iso2'])
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);
