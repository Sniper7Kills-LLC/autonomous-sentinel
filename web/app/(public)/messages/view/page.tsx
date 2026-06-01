'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { MessageDetailView } from '@/components/browse/MessageDetailView';

/**
 * Message-detail surface at `/messages/view?id=<uuid>`.
 *
 * The site ships as a static export (`output: 'export'` — see
 * next.config.mjs), which cannot serve a runtime-dynamic `[id]`
 * segment without build-time `generateStaticParams`, and message IDs
 * are unbounded/live. So the detail id rides as a query param on a
 * single static page that fetches client-side. Migrate to a clean
 * `/messages/[id]` once the app moves to SSR hosting (#330).
 */
export default function MessageDetailRoute() {
  return (
    <>
      <PageHeader eyebrow="§02 · Message" title="Detail" />
      <Suspense fallback={null}>
        <DetailBody />
      </Suspense>
    </>
  );
}

function DetailBody() {
  const params = useSearchParams();
  const id = params.get('id');
  if (!id) {
    return (
      <p style={{ color: 'var(--color-fg-faint)', fontFamily: 'var(--font-jb-mono)' }}>
        No message id supplied. Append <code>?id=&lt;uuid&gt;</code> to the URL.
      </p>
    );
  }
  return <MessageDetailView messageId={id} />;
}
