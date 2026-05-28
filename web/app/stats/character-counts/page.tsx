'use client';

import { Suspense } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { StatsDeepNav, StatsCharacterCounts } from '../StatsSection';

export default function StatsCharacterCountsPage() {
  return (
    <PageShell
      eyebrow="§03.B · Stats"
      title="Character counts"
      lede="Distribution of body lengths across all message types. The 30-character canonical ALLSTATIONS body usually dominates."
    >
      <Suspense fallback={null}>
        <StatsDeepNav />
        <StatsCharacterCounts />
      </Suspense>
    </PageShell>
  );
}
