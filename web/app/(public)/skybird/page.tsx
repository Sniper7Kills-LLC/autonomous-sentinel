'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { MessageFiltersBar } from '@/components/browse/MessageFilters';
import { MessagesList } from '@/components/browse/MessagesList';

export default function SkybirdPage() {
  return (
    <>
      <PageHeader
        eyebrow="§02 · Skybird"
        title="Skybird"
        lede="Free-form Skybird broadcasts — typically command + control traffic from major HFGCS sites. Distinct enum from Skykings; this page filters to SKYBIRD only."
      />
      <Suspense fallback={null}>
        <MessageFiltersBar forcedType="SKYBIRD" />
        <MessagesList forcedType="SKYBIRD" />
      </Suspense>
    </>
  );
}
