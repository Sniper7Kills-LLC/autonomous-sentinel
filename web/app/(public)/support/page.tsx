'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { Alert } from '@/components/ui/Alert';
import { SupportTiers } from '@/components/donations/SupportTiers';

/**
 * Recurring supporter-tiers page (#104) at `/support`.
 *
 * Public page; subscribing requires sign-in (gated at the CTA). Three
 * tiers at $3 / $7 / $15 per CLAUDE.md. Checkout + Customer Portal are
 * STUBBED (no real Stripe; #206/#208/#210/#211). Static export → client
 * component.
 */
export default function SupportPage() {
  return (
    <>
      <PageHeader
        eyebrow="§ Support · Tiers"
        title="Supporter subscriptions"
        lede="Recurring support unlocks historical access, bulk downloads, and integrations while keeping the public archive free forever. Prefer a one-off? Use the donate page."
      />
      <Alert tone="info" title="Payments are in test mode">
        Subscriptions are not yet enabled on this build. Browse the tiers freely — no card will be
        charged until live Stripe billing is configured.
      </Alert>
      <SupportTiers />
    </>
  );
}
