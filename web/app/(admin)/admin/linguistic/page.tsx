'use client';

import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { LinguisticPromptTemplates } from '@/components/admin/LinguisticPromptTemplates';
import { LinguisticWhisperPromptEditor } from '@/components/admin/LinguisticWhisperPromptEditor';
import { LinguisticRulesQueue } from '@/components/admin/LinguisticRulesQueue';
import { LinguisticThresholdsEditor } from '@/components/admin/LinguisticThresholdsEditor';
import { LinguisticSchemasEditor } from '@/components/admin/LinguisticSchemasEditor';
import styles from '@/components/admin/AdminLinguistic.module.css';

/**
 * Admin · Linguistic Logic config (#546).
 *
 * Stacked surfaces, admin-only: the Bedrock prompt-template editor, the
 * generated-rule review queue, the per-type confidence-threshold editor
 * (#110), and the per-type schema editor (#110). `AdminGate` decides
 * what to render; the AppSync models enforce authorization server-side
 * regardless.
 *
 * Deferred: a Test Bench that runs the Linguistic Logic Lambda on a
 * sample transcript needs that Lambda (#62–#66); atomic prompt-version
 * activation is #572; server-side audit-log diffs per mutation are #479.
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
          <LinguisticWhisperPromptEditor />
          <LinguisticThresholdsEditor />
          <LinguisticSchemasEditor />
          <LinguisticRulesQueue />
        </div>
      </AdminGate>
    </>
  );
}
