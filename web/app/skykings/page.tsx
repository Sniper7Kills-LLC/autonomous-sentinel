'use client';

import { Suspense } from 'react';
import { PageShell } from '@/components/layout/PageShell';
import { MessageFiltersBar } from '@/components/browse/MessageFilters';
import { MessagesList } from '@/components/browse/MessagesList';

export default function SkykingsPage() {
  return (
    <PageShell
      eyebrow="§02 · Skykings"
      title="Skykings"
      lede="Time-critical priority broadcasts. Pre-2015 entries use a 3-character phonetic group; post-2015 traffic switched to codeword names. Both render distinctly on the detail page."
    >
      <Suspense fallback={null}>
        <MessageFiltersBar forcedType="SKYKING" />
        <MessagesList forcedType="SKYKING" />
      </Suspense>
    </PageShell>
  );
}
