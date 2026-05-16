import { a } from '@aws-amplify/backend';

/**
 * BannedRegionPage — admin-edited markdown landing page per blocked
 * ISO-3166-1 alpha-2 country code (#42).
 *
 * Public read so the WAF custom-response Lambda (phase 9) can fetch by
 * countryCode and render the appropriate page to visitors blocked at the
 * edge. Admin-only writes.
 */
export const BannedRegionPage = a
  .model({
    countryCode: a.string().required(),
    title: a.string().required(),
    bodyMarkdown: a.string().required(),
    enabled: a.boolean().default(true),
  })
  .identifier(['countryCode'])
  .authorization((allow) => [
    allow.guest().to(['read']),
    allow.groups(['admin']).to(['read', 'create', 'update', 'delete']),
  ]);
