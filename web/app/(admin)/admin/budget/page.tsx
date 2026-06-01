'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { BudgetConfigEditor } from '@/components/admin/BudgetConfigEditor';

/**
 * Admin · AWS Budget threshold tuning (#116).
 *
 * Records the intended soft / loud / hard USD thresholds, the notification
 * recipient, and per-tier actions that mirror CLAUDE.md → Stack → Budgets
 * ($50 / $100 / $200). Persists to the admin-only `BudgetConfig` singleton.
 *
 * Honest framing (see the editor's defer note): the LIVE AWS Budget is
 * defined in CDK (`amplify/budgets.ts`) from the `AS_BUDGET_*` env vars at
 * DEPLOY time and cannot read DynamoDB at runtime. Editing only RECORDS the
 * intended values; pushing them into the env vars + redeploying (the sync
 * step) and live month-to-date spend display (Cost Explorer, #303) are both
 * DEFERRED.
 *
 * Create/update is gated to the `admin` Cognito group server-side, so the
 * editor sits behind `<AdminGate>`. The AppSync model enforces authorization
 * regardless; the gate only decides what to render.
 */
export default function AdminBudgetPage() {
  return (
    <>
      <PageHeader
        eyebrow="§11 · Admin"
        title="AWS budget"
        lede="Record the soft / loud / hard budget thresholds, notification recipient, and per-tier actions. Administrators only."
      />
      <AdminGate>
        <BudgetConfigEditor />
      </AdminGate>
    </>
  );
}
