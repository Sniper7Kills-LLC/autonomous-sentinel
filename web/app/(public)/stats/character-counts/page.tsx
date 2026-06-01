'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatsDeepNav, StatsCharacterCounts } from '../StatsSection';

export default function StatsCharacterCountsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§03.B · Stats"
        title="Character frequency"
        lede="How often each character (A–Z, 0–9) appears across ALLSTATIONS message bodies — a frequency ranking of the decoded alphabet over the recent window."
      />
      <Suspense fallback={null}>
        <StatsDeepNav />
        <StatsCharacterCounts />
      </Suspense>
    </>
  );
}
