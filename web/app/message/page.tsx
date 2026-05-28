'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageShell } from '@/components/layout/PageShell';
import { MessageDetailView } from '@/components/browse/MessageDetailView';

export default function MessageDetailRoute() {
  return (
    <PageShell eyebrow="§02 · Message" title="Detail" lede={null}>
      <Suspense fallback={null}>
        <DetailBody />
      </Suspense>
    </PageShell>
  );
}

function DetailBody() {
  const params = useSearchParams();
  const id = params.get('id');
  if (!id) {
    return (
      <p style={{ color: 'var(--text-2)', fontFamily: 'var(--font-jb-mono)' }}>
        No message id supplied. Append <code>?id=&lt;uuid&gt;</code> to the URL.
      </p>
    );
  }
  return <MessageDetailView messageId={id} />;
}
