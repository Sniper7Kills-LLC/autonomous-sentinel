'use client';

import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatsDeepNav, StatsDailyCounts } from '../StatsSection';

export default function StatsDailyCountsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§03.A · Stats"
        title="Daily counts"
        lede="Messages catalogued per UTC date. Useful for spotting bursts (exercise traffic, propagation events) at a glance."
      />
      <Suspense fallback={null}>
        <StatsDeepNav />
        <StatsDailyCounts />
      </Suspense>
    </>
  );
}
