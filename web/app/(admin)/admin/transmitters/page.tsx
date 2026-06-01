'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { TransmitterEditor } from '@/components/admin/TransmitterEditor';

/**
 * Admin · Transmitter editor (#108).
 *
 * CRUD over the admin-managed `Transmitter` list — the known EAM
 * broadcast sites shown publicly on the propagation map (#83) and used
 * to attribute which transmitter likely originated a captured signal.
 *
 * Create/update/delete is gated to the `admin` Cognito group (NOT
 * moderator) server-side, so the editor sits behind `<AdminGate>`:
 * moderators who can reach the `(admin)` group still see the
 * admin-required notice. The AppSync model enforces authorization
 * regardless; the gate only decides what to render.
 */
export default function AdminTransmittersPage() {
  return (
    <>
      <PageHeader
        eyebrow="§06 · Admin"
        title="Transmitters"
        lede="Maintain the admin-managed list of known EAM broadcast sites shown on the propagation map. Administrators only."
      />
      <AdminGate>
        <TransmitterEditor />
      </AdminGate>
    </>
  );
}
