'use client';

import { Suspense } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { StatsDeepNav, StatsOverview } from './StatsSection';

export default function StatsIndexPage() {
  return (
    <PageShell
      eyebrow="§03 · Stats"
      title="Stats & Charts"
      lede="High-signal aggregations over the public archive. Drill into any chart for the full-size view + filter controls."
    >
      <Suspense fallback={null}>
        <StatsDeepNav />
        <StatsOverview />
      </Suspense>
    </PageShell>
  );
}
