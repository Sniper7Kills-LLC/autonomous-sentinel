'use client';

import { Suspense } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { MessageFiltersBar } from '@/components/browse/MessageFilters';
import { MessagesList } from '@/components/browse/MessagesList';

export default function MessagesPage() {
  return (
    <PageShell
      eyebrow="§02 · Browse"
      title="Messages"
      lede="The full public archive of catalogued broadcasts. Filters survive page refresh and round-trip via the URL — share a filtered link and the recipient sees the same view."
    >
      <Suspense fallback={null}>
        <MessageFiltersBar />
        <MessagesList />
      </Suspense>
    </PageShell>
  );
}
