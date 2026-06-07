'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { SdrReviewQueue } from '@/components/admin/SdrReviewQueue';

/**
 * Admin · SDR review queue (#785).
 *
 * Lists PENDING public SDR submissions (third-party receivers like KiwiSDR/WebSDR
 * submitted by community members) and allows admins to approve or reject them.
 *
 * Moderators can reach this page via the admin sidebar (mod access) but the
 * server enforces admin-only auth on the `reviewSdr` mutation. This page renders
 * behind `<AdminGate>` which shows the admin-required notice to mods.
 */
export default function AdminSdrsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§15 · Admin"
        title="SDR Submissions"
        lede="Review community-submitted public SDR receivers (KiwiSDR, WebSDR, etc.) before they appear on the propagation map. Administrators only."
      />
      <AdminGate>
        <SdrReviewQueue />
      </AdminGate>
    </>
  );
}
