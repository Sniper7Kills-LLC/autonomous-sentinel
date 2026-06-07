'use client';

import { useId, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { AdminGate } from '@/components/admin/AdminGate';
import { LinguisticPromptTemplates } from '@/components/admin/LinguisticPromptTemplates';
import { LinguisticWhisperPromptEditor } from '@/components/admin/LinguisticWhisperPromptEditor';
import { LinguisticRulesQueue } from '@/components/admin/LinguisticRulesQueue';
import { LinguisticThresholdsEditor } from '@/components/admin/LinguisticThresholdsEditor';
import { LinguisticSchemasEditor } from '@/components/admin/LinguisticSchemasEditor';
import styles from './LinguisticTabs.module.css';

/**
 * Admin · Linguistic Logic config (#546).
 *
 * The five config surfaces — Bedrock prompt-template versions, the Whisper
 * prompt, per-type confidence thresholds (#110), per-type schemas (#110), and
 * the generated-rule review queue — used to stack into one long scroll. They're
 * now split across tabs: every panel stays mounted (so in-flight edits + loaded
 * data survive a tab switch) but only the active one is shown. `AdminGate`
 * decides what renders; the AppSync models enforce authorization server-side.
 */

const TABS = [
  { id: 'prompt', label: 'Prompt templates', node: <LinguisticPromptTemplates /> },
  { id: 'whisper', label: 'Whisper prompt', node: <LinguisticWhisperPromptEditor /> },
  { id: 'thresholds', label: 'Thresholds', node: <LinguisticThresholdsEditor /> },
  { id: 'schemas', label: 'Schemas', node: <LinguisticSchemasEditor /> },
  { id: 'rules', label: 'Rules queue', node: <LinguisticRulesQueue /> },
] as const;

export default function AdminLinguisticPage() {
  const [active, setActive] = useState<(typeof TABS)[number]['id']>('prompt');
  const baseId = useId();

  return (
    <>
      <PageHeader
        eyebrow="§09 · Admin"
        title="Linguistic Logic"
        lede="Manage the Bedrock fallback prompt versions and review the rules emitted by the self-improving parse loop. Administrators only."
      />
      <AdminGate>
        <div className={styles.page}>
          <div className={styles.tablist} role="tablist" aria-label="Linguistic Logic sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={active === t.id}
                aria-controls={`${baseId}-panel-${t.id}`}
                tabIndex={active === t.id ? 0 : -1}
                className={styles.tab}
                onClick={() => setActive(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {TABS.map((t) => (
            <div
              key={t.id}
              role="tabpanel"
              id={`${baseId}-panel-${t.id}`}
              aria-labelledby={`${baseId}-tab-${t.id}`}
              className={styles.panel}
              hidden={active !== t.id}
            >
              {t.node}
            </div>
          ))}
        </div>
      </AdminGate>
    </>
  );
}
