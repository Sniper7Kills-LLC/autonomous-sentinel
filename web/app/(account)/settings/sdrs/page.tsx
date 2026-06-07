'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { SdrSettingsPanel } from '@/components/account/SdrSettingsPanel';

/**
 * `/settings/sdrs` — Member SDR registration and public SDR submission (#785).
 *
 * Two sub-forms:
 *   - Register an Owned SDR (member's own receiver): name, map-pick location,
 *     granularity, notes, publicVisible toggle.
 *   - Submit a Public SDR (third-party receiver like KiwiSDR/WebSDR): name,
 *     URL, map-pick location, notes → lands PENDING for admin review.
 *
 * Also lists the caller's existing SDRs with kind + reviewStatus badges.
 *
 * The `(account)` route group already gates this behind `<RequireAuth>`.
 */
export default function SdrSettingsPage() {
  return (
    <>
      <PageHeader eyebrow="Settings" title="SDR Registration" lede="Register your own SDR or submit a public receiver for inclusion on the map." />
      <SdrSettingsPanel />
    </>
  );
}
