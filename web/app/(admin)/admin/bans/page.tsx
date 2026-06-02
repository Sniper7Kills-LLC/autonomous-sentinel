'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { BanManagement } from '@/components/admin/BanManagement';

/**
 * Admin · Ban management (#112).
 *
 * v1 ships the Users tab (ban / unban accounts via banUser / unbanUser,
 * audit-backed). IP-CIDR + country tabs are placeholders pending the AWS
 * WAF rulesets (#199 / #200). `AdminGate` gates render to the admin group;
 * the ban mutations + User reads are admin-only server-side regardless.
 */
export default function AdminBansPage() {
  return (
    <>
      <PageHeader
        eyebrow="§09 · Admin"
        title="Ban management"
        lede="Ban + unban user accounts. IP-range and country blocks arrive with AWS WAF. Administrators only."
      />
      <AdminGate>
        <BanManagement />
      </AdminGate>
    </>
  );
}
