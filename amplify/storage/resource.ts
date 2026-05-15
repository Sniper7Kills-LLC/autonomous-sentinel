import { defineStorage } from '@aws-amplify/backend';

/**
 * S3 buckets for Autonomous Sentinel.
 *
 * Layout (per CLAUDE.md):
 *   recordings/originals/{recordingId}    — exactly what the user uploaded (archival)
 *   recordings/web/{recordingId}.opus     — Opus 32 kbps mono web canonical
 *   pipeline-temp/...                     — pre-process working files (lifecycle: 7-day expiry)
 *   exports/{userId}/{exportId}.zip       — paid bulk download artifacts
 *
 * Versioning: 30-day delete-marker retention on recordings/* (configured in CDK overrides).
 */
export const storage = defineStorage({
  name: 'autonomousSentinelMedia',
  access: (allow) => ({
    'recordings/originals/*': [
      allow.authenticated.to(['read', 'write']),
      allow.guest.to(['read']),
    ],
    'recordings/web/*': [allow.guest.to(['read']), allow.authenticated.to(['read'])],
    'pipeline-temp/*': [allow.authenticated.to(['read', 'write', 'delete'])],
    'exports/{entity_id}/*': [allow.entity('identity').to(['read'])],
  }),
});
