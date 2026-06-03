/**
 * Public banned-region landing page, no-ISO fallback (#202).
 *
 * Entered when a blocked visitor lands on `/blocked` without a country in
 * the path. The country is resolved from the `cloudfront-viewer-country`
 * request header (CloudFront in front of this app injects it); absent →
 * null, which `fetchBlockedContent` resolves to the generic default.
 *
 * Same as `/blocked/[iso2]`: the WAF custom response already returns HTTP
 * 403 + redirect; this server component renders at 200 with `noindex`.
 * Strict-403 from the page itself is DEFERRED (documented on #202).
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { BlockedRegionLoader } from '@/components/blocked/BlockedRegionLoader';

export const metadata: Metadata = {
  title: 'Access restricted',
  robots: { index: false, follow: false },
};

export default async function BlockedPage() {
  const headerList = await headers();
  const iso2 = headerList.get('cloudfront-viewer-country');
  return <BlockedRegionLoader iso2={iso2} />;
}
