/**
 * Public banned-region landing page (#202) — `/blocked?country=<ISO2>`.
 *
 * The WAF custom response returns HTTP 403 and redirects a blocked-country
 * visitor to `/blocked`. This is a static export (`output: 'export'`), so:
 *   - there is no request runtime to read `cloudfront-viewer-country`, and
 *   - a dynamic `[iso2]` segment can't be statically served.
 * So the country (when known) rides as `?country=<ISO2>`, read client-side by
 * `<BlockedRegionLoader>`; a bare `/blocked` resolves to the generic default.
 *
 * This server component stays static and owns the `noindex` metadata (these
 * ban pages must never be indexed); the client loader sits under a `<Suspense>`
 * boundary as `useSearchParams()` requires under static export. The page
 * renders at HTTP 200 — strict-403 from the page itself would need a route
 * handler and is DEFERRED (documented on #202); the WAF response already 403s.
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BlockedRegionLoader } from '@/components/blocked/BlockedRegionLoader';

export const metadata: Metadata = {
  title: 'Access restricted',
  robots: { index: false, follow: false },
};

export default function BlockedPage() {
  return (
    <Suspense fallback={null}>
      <BlockedRegionLoader />
    </Suspense>
  );
}
