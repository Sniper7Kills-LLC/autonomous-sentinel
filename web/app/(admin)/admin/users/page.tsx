'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { GroupManagement } from '@/components/admin/GroupManagement';

/**
 * Admin · User group management (#743).
 *
 * Add/remove a user's Cognito groups (admin / moderator / member /
 * diagnostics). The `diagnostics` group gates the deep linguistic-trace
 * debug surface. `AdminGate` gates render to the admin group; the
 * `setUserGroup` / `listUserGroups` operations are admin-only server-side
 * regardless.
 */
export default function AdminUsersPage() {
  return (
    <>
      <PageHeader
        eyebrow="§09 · Admin"
        title="User groups"
        lede="Manage Cognito group membership. The diagnostics group unlocks the deep linguistic-trace debug view. Administrators only."
      />
      <AdminGate>
        <GroupManagement />
      </AdminGate>
    </>
  );
}
