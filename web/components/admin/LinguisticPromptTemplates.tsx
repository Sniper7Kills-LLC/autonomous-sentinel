'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { MarkdownPreview } from './MarkdownPreview';
import {
  listPromptTemplates,
  saveNewTemplateVersion,
  activateTemplate,
  FALLBACK_SYSTEM_PROMPT,
  ACTIVE_PROMPT_ID,
  type DisplayTemplate,
} from '@/lib/admin/linguistic';
import styles from './AdminLinguistic.module.css';

/**
 * LinguisticPromptTemplate CRUD surface (#546).
 *
 * Lists every version of the `linguistic-parse-bedrock` prompt, marks
 * the active one, lets an admin load the git-reviewable system default
 * into the editor ("copy the system default"), save a new version
 * (bumps `version`), and activate a version (flips `isActive`).
 *
 * Activation + version assignment are approximated client-side until
 * the deferred atomic mutations ship (see `lib/admin/linguistic.ts`);
 * the UI states this in the helper copy.
 */
export function LinguisticPromptTemplates() {
  const [templates, setTemplates] = useState<DisplayTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listPromptTemplates();
      setTemplates(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prompt templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadActiveIntoEditor = useCallback(() => {
    const active = templates.find((t) => t.isActive);
    setDraft(active?.body ?? FALLBACK_SYSTEM_PROMPT);
    setStatus(
      active
        ? `Loaded active v${active.version} into the editor.`
        : 'No active version — loaded the system default.',
    );
  }, [templates]);

  const copySystemDefault = useCallback(() => {
    setDraft(FALLBACK_SYSTEM_PROMPT);
    setStatus('Loaded the git-reviewed system default into the editor.');
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const created = await saveNewTemplateVersion({
        body: draft,
        notes: notes || null,
        existing: templates,
      });
      setStatus(`Saved version ${created.version} (inactive — activate it below to make it live).`);
      setNotes('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the new version.');
    } finally {
      setBusy(false);
    }
  }, [draft, notes, templates, reload]);

  const activate = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      setStatus(null);
      try {
        const { activeCount } = await activateTemplate(id, templates);
        await reload();
        // The flip is non-atomic (#572). Surface a partial-failure state
        // — zero or multiple active rows — to the admin instead of
        // reporting a clean activation.
        if (activeCount === 1) {
          setStatus(
            'Activated. The Linguistic Logic Lambda picks it up on its next cache refresh.',
          );
        } else if (activeCount === 0) {
          setError(
            'Activation did not complete: no version is currently active. Re-run activation (the activate step may have failed after deactivating the old version — see #572).',
          );
        } else {
          setError(
            `Activation left ${activeCount} versions active (expected 1). A concurrent edit or partial failure occurred; re-run activation to converge (#572). The Lambda will use the highest version until then.`,
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to activate the version.');
      } finally {
        setBusy(false);
      }
    },
    [templates, reload],
  );

  const placeholderOk = draft.includes('{{TRANSCRIPT}}');

  return (
    <section className={styles.section} aria-labelledby="prompt-heading">
      <header className={styles.sectionHead}>
        <h2 id="prompt-heading" className={styles.sectionTitle}>
          Prompt templates
        </h2>
        <span className={styles.eyebrow}>promptId · {ACTIVE_PROMPT_ID}</span>
      </header>
      <p className={styles.muted}>
        Versioned Bedrock fallback prompts. Exactly one version is active; the Lambda renders it
        against each transcript. Activation and version numbering are applied client-side and are{' '}
        <strong>not atomic</strong> until the backend mutations ship (#572): two admins activating
        or saving at the same time can race. Activation re-checks the active count and warns here if
        it does not settle on exactly one.
      </p>

      {loading ? (
        <p className={styles.muted} role="status">
          Loading versions…
        </p>
      ) : (
        <ul className={styles.list} data-testid="template-list">
          {templates.length === 0 ? (
            <li className={styles.empty}>
              No saved versions yet — the Lambda uses the system default.
            </li>
          ) : (
            templates.map((t) => (
              <li
                key={t.id}
                className={t.isActive ? `${styles.row} ${styles.rowActive}` : styles.row}
              >
                <div className={styles.rowBody}>
                  <span className={styles.idMono}>
                    v{t.version}
                    {t.isActive && <span className={styles.activeBadge}> ACTIVE</span>}
                  </span>
                  {t.notes && <span className={styles.muted}>{t.notes}</span>}
                </div>
                <div className={styles.rowRight}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setDraft(t.body);
                      setStatus(`Loaded v${t.version} into the editor.`);
                    }}
                  >
                    Edit
                  </Button>
                  {!t.isActive && (
                    <Button
                      variant="success"
                      size="sm"
                      disabled={busy}
                      onClick={() => void activate(t.id)}
                    >
                      Activate
                    </Button>
                  )}
                </div>
              </li>
            ))
          )}
        </ul>
      )}

      <div className={styles.editorBlock}>
        <div className={styles.editorActions}>
          <Button variant="ghost" size="sm" onClick={copySystemDefault}>
            Copy the system default
          </Button>
          <Button variant="ghost" size="sm" onClick={loadActiveIntoEditor} disabled={loading}>
            Load active version
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview((v) => !v)}
            aria-pressed={showPreview}
          >
            {showPreview ? 'Hide Markdown preview' : 'Show Markdown preview'}
          </Button>
        </div>
        <label className={styles.fieldLabel} htmlFor="prompt-body">
          Prompt body
        </label>
        <textarea
          id="prompt-body"
          className={styles.textarea}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={16}
          spellCheck={false}
          aria-describedby="prompt-placeholder-hint"
        />
        {showPreview && (
          <>
            <span className={styles.fieldLabel}>Markdown preview</span>
            <MarkdownPreview source={draft} />
          </>
        )}
        <p id="prompt-placeholder-hint" className={placeholderOk ? styles.hintOk : styles.hintBad}>
          {placeholderOk
            ? 'Body contains the required {{TRANSCRIPT}} placeholder.'
            : 'Body must contain the {{TRANSCRIPT}} placeholder before it can be saved.'}
        </p>
        <label className={styles.fieldLabel} htmlFor="prompt-notes">
          Notes (optional)
        </label>
        <input
          id="prompt-notes"
          className={styles.input}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What changed in this version"
        />
        <div className={styles.editorActions}>
          <Button
            variant="primary"
            size="md"
            loading={busy}
            disabled={busy || !placeholderOk || draft.trim().length === 0}
            onClick={() => void save()}
          >
            Save new version
          </Button>
        </div>
      </div>

      {status && (
        <p className={styles.statusOk} role="status">
          {status}
        </p>
      )}
      {error && (
        <p className={styles.statusErr} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
