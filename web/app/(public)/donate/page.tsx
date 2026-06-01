'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { Alert } from '@/components/ui/Alert';
import { DonationForm } from '@/components/donations/DonationForm';

/**
 * One-time donation page (#103) at `/donate`.
 *
 * Public — anyone may donate, signed in or not. The Donate CTA calls a
 * STUBBED Checkout (no real Stripe; #206/#208 wire that later) and shows
 * a test-mode notice. Static export: this is a client component and
 * reads cancellation status from a query param (`?status=cancelled`).
 */
export default function DonatePage() {
  return (
    <>
      <PageHeader
        eyebrow="§ Support · Donate"
        title="One-time donation"
        lede="Autonomous Sentinel is free to browse and runs on volunteer SDRs and donor support. A one-time gift keeps the lights on. Recurring supporter tiers live on the support page."
      />
      <Suspense fallback={null}>
        <CancelNotice />
      </Suspense>
      <Alert tone="info" title="Payments are in test mode">
        Billing is not yet enabled on this build. You can explore the form, but no card will be
        charged. Live Stripe Checkout lands once billing is configured.
      </Alert>
      <DonationForm />
    </>
  );
}

function CancelNotice() {
  const params = useSearchParams();
  if (params.get('status') !== 'cancelled') return null;
  return (
    <Alert tone="warn" title="Donation cancelled">
      You backed out of Checkout — nothing was charged. Pick an amount below to try again whenever
      you&rsquo;re ready.
    </Alert>
  );
}
