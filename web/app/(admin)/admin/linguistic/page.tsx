'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { LinguisticPromptTemplates } from '@/components/admin/LinguisticPromptTemplates';
import { LinguisticRulesQueue } from '@/components/admin/LinguisticRulesQueue';
import styles from '@/components/admin/AdminLinguistic.module.css';

/**
 * Admin · Linguistic Logic config (#546).
 *
 * Two surfaces, admin-only: the Bedrock prompt-template editor and the
 * generated-rule review queue. `AdminGate` decides what to render; the
 * AppSync models enforce authorization server-side regardless.
 */
export default function AdminLinguisticPage() {
  return (
    <>
      <PageHeader
        eyebrow="§09 · Admin"
        title="Linguistic Logic"
        lede="Manage the Bedrock fallback prompt versions and review the rules emitted by the self-improving parse loop. Administrators only."
      />
      <AdminGate>
        <div className={styles.page}>
          <LinguisticPromptTemplates />
          <LinguisticRulesQueue />
        </div>
      </AdminGate>
    </>
  );
}
