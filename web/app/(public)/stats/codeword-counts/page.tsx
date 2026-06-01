'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatsDeepNav, StatsCodewordCounts } from '../StatsSection';

export default function StatsCodewordCountsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§03.C · Stats"
        title="Codeword frequency"
        lede="How many times each distinct codeword was used across message bodies — a ranked frequency list over the recent window."
      />
      <Suspense fallback={null}>
        <StatsDeepNav />
        <StatsCodewordCounts />
      </Suspense>
    </>
  );
}
