import { a } from '@aws-amplify/backend';

/**
 * BannedIp — admin-managed CIDR block list fed into the WAF IPSets by
 * the `wafSync` Lambda (issues #200/#201).
 *
 * One row per IPv4 or IPv6 CIDR (`cidr` is the identifier, e.g.
 * "203.0.113.0/24"). The `scope` enum decides the block surface:
 * write-only (default — the sync Lambda treats a missing/anything-
 * not-`read_write` value as `write`) vs `read_write`.
 *
 * `expiresAt` is optional; when it is in the past the sync Lambda
 * drops the entry. TTL-style natural cleanup is enforced by the
 * daily/recurring `wafSync` reconcile, NOT a DynamoDB TTL attribute,
 * because Amplify-managed tables don't expose a TTL knob cleanly.
 *
 * Admin-only for everything — ban lists are sensitive, so there is NO
 * guest/public read.
 */
export const BannedIp = a
  .model({
    cidr: a.string().required(),
    ipVersion: a.enum(['IPV4', 'IPV6']),
    scope: a.enum(['write', 'read_write']),
    reason: a.string(),
    expiresAt: a.datetime(),
    createdBy: a.string(),
  })
  .identifier(['cidr'])
  .authorization((allow) => [allow.groups(['admin']).to(['read', 'create', 'update', 'delete'])]);
