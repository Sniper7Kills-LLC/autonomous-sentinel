'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatsDeepNav, StatsCodewordCounts } from '../StatsSection';

export default function StatsCodewordCountsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§03.C · Stats"
        title="Codeword counts"
        lede="Distribution of codeword groups per message — useful for spotting outliers where the parser found more (or fewer) groups than expected."
      />
      <Suspense fallback={null}>
        <StatsDeepNav />
        <StatsCodewordCounts />
      </Suspense>
    </>
  );
}
