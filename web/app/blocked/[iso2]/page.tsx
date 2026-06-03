/**
 * Public banned-region landing page, per-country (#202).
 *
 * A WAF custom response already returns HTTP 403 and redirects a
 * blocked-country visitor here (`/blocked/<ISO2>`). This route renders at
 * HTTP 200 with `noindex` — an App Router server component cannot set an
 * arbitrary 403 status without a dedicated route handler, so strict-403
 * from the page itself is DEFERRED (documented on #202). The noindex
 * metadata keeps these ban pages out of search indexes regardless.
 */
import type { Metadata } from 'next';
import { BlockedRegionLoader } from '@/components/blocked/BlockedRegionLoader';

export const metadata: Metadata = {
  title: 'Access restricted',
  robots: { index: false, follow: false },
};

interface BlockedCountryPageProps {
  params: Promise<{ iso2: string }>;
}

export default async function BlockedCountryPage({ params }: BlockedCountryPageProps) {
  const { iso2 } = await params;
  // Normalization (and any invalid-code fallback) happens inside the
  // loader's `fetchBlockedContent`.
  return <BlockedRegionLoader iso2={iso2} />;
}
