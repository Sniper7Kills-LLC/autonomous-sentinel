'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { ReputationConfigEditor } from '@/components/admin/ReputationConfigEditor';

/**
 * Admin · Vote-weight / reputation formula tuning (#117).
 *
 * Edit every coefficient + cap in the CLAUDE.md reputation formula
 * without a code change, with a live preview of an example user's weight.
 * Persists to the admin-only `ReputationConfig` singleton.
 *
 * Create/update is gated to the `admin` Cognito group server-side, so the
 * editor sits behind `<AdminGate>`: moderators who can reach the
 * `(admin)` group still see the admin-required notice. The AppSync model
 * enforces authorization regardless; the gate only decides what to render.
 *
 * The recompute-on-publish/accept Lambda that APPLIES the formula to
 * Reputation rows is #480 — out of scope; this is the config + tuning UI
 * + the pure formula only.
 */
export default function AdminReputationPage() {
  return (
    <>
      <PageHeader
        eyebrow="§10 · Admin"
        title="Reputation formula"
        lede="Tune the vote-weight / reputation coefficients and preview an example user's weight before saving. Administrators only."
      />
      <AdminGate>
        <ReputationConfigEditor />
      </AdminGate>
    </>
  );
}
