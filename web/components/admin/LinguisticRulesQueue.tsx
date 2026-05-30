'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { RegexTester } from './RegexTester';
import {
  listRules,
  setRuleEnabled,
  deleteRule,
  RULE_AUTO_ACTIVATE_THRESHOLD,
  type AdminRule,
} from '@/lib/admin/linguistic';
import styles from './AdminLinguistic.module.css';

/**
 * LinguisticRule review queue (#546).
 *
 * Lists every rule with its component, message type, pattern,
 * confidence and enabled state. AI-emitted rules below the
 * auto-activation bar (0.85) land disabled; an admin can activate a
 * vetted rule, deactivate a bad one, or delete it outright. The
 * human side of the hybrid-activation loop (#543/#542).
 */
export function LinguisticRulesQueue() {
  const [rules, setRules] = useState<AdminRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [onlyDisabled, setOnlyDisabled] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRules(await listRules());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load rules.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = useCallback(async (rule: AdminRule) => {
    setBusyId(rule.id);
    setError(null);
    try {
      await setRuleEnabled(rule.id, !rule.enabled);
      setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the rule.');
    } finally {
      setBusyId(null);
    }
  }, []);

  const remove = useCallback(async (rule: AdminRule) => {
    setBusyId(rule.id);
    setError(null);
    try {
      await deleteRule(rule.id);
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the rule.');
    } finally {
      setBusyId(null);
    }
  }, []);

  const visible = onlyDisabled ? rules.filter((r) => !r.enabled) : rules;

  return (
    <section className={styles.section} aria-labelledby="rules-heading">
      <header className={styles.sectionHead}>
        <h2 id="rules-heading" className={styles.sectionTitle}>
          Rule review queue
        </h2>
        <span className={styles.eyebrow}>auto-activate ≥ {RULE_AUTO_ACTIVATE_THRESHOLD}</span>
      </header>
      <p className={styles.muted}>
        Rules at or above confidence {RULE_AUTO_ACTIVATE_THRESHOLD} auto-activate; lower-confidence
        AI-emitted rules land disabled and wait here for a human to vet, activate, or delete.
      </p>

      <label className={styles.filterToggle}>
        <input
          type="checkbox"
          checked={onlyDisabled}
          onChange={(e) => setOnlyDisabled(e.target.checked)}
        />
        Show only disabled (review queue)
      </label>

      {loading ? (
        <p className={styles.muted} role="status">
          Loading rules…
        </p>
      ) : (
        <ul className={styles.list} data-testid="rule-list">
          {visible.length === 0 ? (
            <li className={styles.empty}>
              {onlyDisabled ? 'No rules awaiting review.' : 'No rules yet.'}
            </li>
          ) : (
            visible.map((rule) => {
              const belowBar =
                rule.confidence != null && rule.confidence < RULE_AUTO_ACTIVATE_THRESHOLD;
              return (
                <li
                  key={rule.id}
                  className={rule.enabled ? styles.row : `${styles.row} ${styles.rowDisabled}`}
                >
                  <div className={styles.rowBody}>
                    <div className={styles.rowMeta}>
                      <span className={styles.tag}>{rule.component ?? 'TYPE'}</span>
                      <span className={styles.tag}>
                        {rule.messageType || rule.appliesToType || '*'}
                      </span>
                      <span className={belowBar ? styles.confBad : styles.confOk}>
                        conf {rule.confidence != null ? rule.confidence.toFixed(2) : '—'}
                      </span>
                      <span className={styles.tag}>{rule.enabled ? 'ENABLED' : 'DISABLED'}</span>
                    </div>
                    <code className={styles.pattern}>{rule.pattern}</code>
                    {rule.notes && <span className={styles.muted}>{rule.notes}</span>}
                    <details>
                      <summary className={styles.testerSummary}>Test pattern</summary>
                      <RegexTester pattern={rule.pattern} />
                    </details>
                  </div>
                  <div className={styles.rowRight}>
                    <Button
                      variant={rule.enabled ? 'secondary' : 'success'}
                      size="sm"
                      disabled={busyId === rule.id}
                      onClick={() => void toggle(rule)}
                    >
                      {rule.enabled ? 'Deactivate' : 'Activate'}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busyId === rule.id}
                      onClick={() => void remove(rule)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}

      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
