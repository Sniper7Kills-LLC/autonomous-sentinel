import { a } from '@aws-amplify/backend';

/**
 * Callsign — known sender / receiver callsign dictionary (#39).
 *
 * Quick-select source for the upload client + web UI; free-form entry is
 * still allowed and runs through an admin-review queue when AI-suggested
 * (`approved=false` until admin merges).
 *
 * Migration seeds this table from the legacy DB plus an AI-assisted dedup
 * pass (phase 7 #136). New entries auto-flagged for merge land with
 * `approved=false`.
 */
export const Callsign = a
  .model({
    normalized: a.string().required(),
    variants: a.string().array(),
    source: a.enum(['LEGACY', 'ADMIN', 'AI_SUGGESTED']),
    confidence: a.float(),
    approved: a.boolean().default(true),
    notes: a.string(),
  })
  .secondaryIndexes((i) => [
    // Admin pending-review queue: list AI-suggested entries to approve / merge.
    i('source'),
  ])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
