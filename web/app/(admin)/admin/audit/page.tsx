'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AuditLogViewer } from '@/components/admin/AuditLogViewer';

/**
 * Admin · Audit log viewer (#111).
 *
 * Read-only, filterable view of every AuditLog entry — the operator's
 * accountability surface for incident review and ban appeals. The log is
 * append-only and retained forever, so this page exposes no mutation
 * affordances.
 *
 * The AuditLog model grants read to admin AND moderator (unlike the
 * admin-only Linguistic surfaces), so this page intentionally does NOT
 * wrap in the admin-only `AdminGate`. The surrounding `(admin)` route
 * group (`AdminChrome`) already gates render to the admin + moderator
 * Cognito groups, and the model enforces the same authorization
 * server-side on every read.
 */
export default function AdminAuditPage() {
  return (
    <>
      <PageHeader
        eyebrow="§09 · Admin"
        title="Audit log"
        lede="Every admin, moderator, and system action with its before/after diff. Read-only; retained forever. Filter by action, actor, target, or date range and export the loaded set to CSV."
      />
      <AuditLogViewer />
    </>
  );
}
