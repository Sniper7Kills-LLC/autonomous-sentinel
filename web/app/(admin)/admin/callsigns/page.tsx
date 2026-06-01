'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { CallsignEditor } from '@/components/admin/CallsignEditor';

/**
 * Admin · Callsign dictionary editor (#109).
 *
 * CRUD over the admin-managed `Callsign` dictionary (#39) — the known
 * sender / receiver callsigns that drive quick-select in the upload
 * client + web UI — plus a merge-queue review tab for AI-suggested /
 * unapproved entries.
 *
 * Create/update/delete is gated to the `admin` Cognito group (NOT
 * moderator) server-side, so the editor sits behind `<AdminGate>`. The
 * AppSync model enforces authorization regardless; the gate only decides
 * what to render.
 *
 * DEFERRED: AI/Bedrock dedup *suggestion generation* (auto-merge above a
 * confidence threshold, queue lower-confidence merges) needs a Bedrock
 * Lambda and is out of scope here — see the migration / Bedrock work
 * (#172, #173). This page is the human CRUD + merge-queue review only.
 */
export default function AdminCallsignsPage() {
  return (
    <>
      <PageHeader
        eyebrow="§07 · Admin"
        title="Callsigns"
        lede="Maintain the sender / receiver callsign dictionary and review AI-suggested merge candidates. Administrators only."
      />
      <AdminGate>
        <CallsignEditor />
      </AdminGate>
    </>
  );
}
