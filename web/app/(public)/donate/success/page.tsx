'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';

/**
 * Donation success confirmation (#103) at `/donate/success`.
 *
 * Real Checkout redirects here with `?session_id=...`; fulfillment is
 * handled by the webhook (#210). This shell just confirms + thanks.
 * While payments are stubbed (#206/#208) it doubles as a test-mode
 * confirmation. Static export: client component, query-param driven.
 */
export default function DonateSuccessPage() {
  return (
    <>
      <PageHeader eyebrow="§ Support · Donate" title="Thank you" />
      <Suspense fallback={null}>
        <SuccessBody />
      </Suspense>
    </>
  );
}

function SuccessBody() {
  const params = useSearchParams();
  const sessionId = params.get('session_id');
  return (
    <>
      <Alert tone="success" title="Your support keeps the archive running">
        Thank you for backing Autonomous Sentinel. A receipt will arrive by email. Supporter badges
        (when applicable) attach to your account once payment is confirmed.
        {sessionId ? (
          <>
            {' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>Ref: {sessionId}</span>
          </>
        ) : (
          ' (Test-mode confirmation — no real charge was made.)'
        )}
      </Alert>
      <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <Link href="/">
          <Button variant="secondary">Back to dashboard</Button>
        </Link>
        <Link href="/support">
          <Button variant="ghost">See recurring supporter tiers</Button>
        </Link>
      </div>
    </>
  );
}
