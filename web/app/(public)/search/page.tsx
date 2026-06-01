'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchResults } from '@/components/search/SearchResults';

/**
 * Full-text search surface at `/search?q=…` (#87).
 *
 * Ships as part of the static export (`output: 'export'`), so the
 * query rides as a URL param read client-side via `useSearchParams`
 * under a Suspense boundary — same pattern as `/messages/view`.
 */
export default function SearchPage() {
  return (
    <>
      <PageHeader
        eyebrow="§ Search"
        title="Search"
        lede="Best-effort full-text search across catalogued broadcast transcripts and callsigns. Combine with the browse filters via the URL."
      />
      <Suspense fallback={null}>
        <SearchResults />
      </Suspense>
    </>
  );
}
