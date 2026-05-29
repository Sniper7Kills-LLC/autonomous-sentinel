'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { PageShell } from '@/components/layout/PageShell';
import { useSessionState } from '@/components/account/SessionGreeting';
import { UploadsList } from '@/components/account/UploadsList';

export default function UploadsPage() {
  return (
    <PageShell
      eyebrow="§04 · Account"
      title="My uploads"
      lede="Every recording you have uploaded, with its current pipeline stage. Failed rows surface the failure reason for triage."
    >
      <Suspense fallback={null}>
        <UploadsBody />
      </Suspense>
    </PageShell>
  );
}

function UploadsBody() {
  const session = useSessionState();
  if (session.loading) {
    return (
      <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
        Checking your session…
      </p>
    );
  }
  if (!session.signedIn) {
    return (
      <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }}>
        Sign in to view your uploads. <Link href="/sign-in">Sign in →</Link>
      </p>
    );
  }
  if (!session.sub) {
    return (
      <p style={{ fontFamily: 'var(--font-jb-mono)', color: 'var(--text-2)' }} role="alert">
        Your session is missing the user identifier — try signing out and back in.
      </p>
    );
  }
  return <UploadsList uploaderId={session.sub} />;
}
