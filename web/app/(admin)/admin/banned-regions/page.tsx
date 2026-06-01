'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { BannedRegionEditor } from '@/components/admin/BannedRegionEditor';

/**
 * Admin · Banned-region landing-page editor (#113).
 *
 * CRUD over the admin-only `BannedRegionPage` model — per-ISO-country
 * markdown shown to visitors blocked from read-restricted countries.
 *
 * Create/update/delete is gated to the `admin` Cognito group (NOT
 * moderator) server-side, so the editor sits behind `<AdminGate>`:
 * moderators who can reach the `(admin)` group still see the
 * admin-required notice. The AppSync model enforces authorization
 * regardless; the gate only decides what to render.
 *
 * Public serving of these pages is DEFERRED to #202 (WAF custom-response);
 * this is the authoring surface only.
 */
export default function AdminBannedRegionsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§08 · Admin"
        title="Banned regions"
        lede="Author the per-country landing page shown to visitors blocked from read-restricted regions. Administrators only."
      />
      <AdminGate>
        <BannedRegionEditor />
      </AdminGate>
    </>
  );
}
