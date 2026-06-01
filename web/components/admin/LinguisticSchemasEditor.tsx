'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { MESSAGE_TYPES, type MessageType } from '@/lib/messages/filters';
import { getLinguisticConfig, upsertLinguisticConfig } from '@/lib/admin/linguistic';
import {
  SCHEMAS_KEY,
  parseSchemaJson,
  normalizeSchemas,
  formatSchemaJson,
  type SchemaMap,
} from '@/lib/admin/linguisticConfig';
import styles from './AdminLinguistic.module.css';

/**
 * Per-message-type schema editor (#110).
 *
 * Loads the `schemas` LinguisticConfig row, renders a JSON textarea per
 * MessageType with live parse/validation, and saves the whole map back
 * as that row's `value`. Save is blocked while any field holds invalid
 * JSON. The Lambda picks the new schemas up on its next cache refresh.
 *
 * Deferred polish: a monaco-editor JSON pane (heavy dep, SSR-tricky) —
 * intentionally a plain textarea + JSON.parse here per #110.
 * Deferred: per-mutation AuditLog diff (#479).
 */
export function LinguisticSchemasEditor() {
  const [drafts, setDrafts] = useState<Record<MessageType, string>>(() => emptyDrafts());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const map: SchemaMap = normalizeSchemas(await getLinguisticConfig(SCHEMAS_KEY));
      const next = {} as Record<MessageType, string>;
      for (const type of MESSAGE_TYPES) next[type] = formatSchemaJson(map[type]);
      setDrafts(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schemas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Per-field parse results: drives the per-field error + the save gate.
  const parsed = useMemo(() => {
    const out = {} as Record<MessageType, ReturnType<typeof parseSchemaJson>>;
    for (const type of MESSAGE_TYPES) out[type] = parseSchemaJson(drafts[type]);
    return out;
  }, [drafts]);

  const allValid = MESSAGE_TYPES.every((t) => parsed[t].ok);

  const setOne = useCallback((type: MessageType, text: string) => {
    setStatus(null);
    setDrafts((prev) => ({ ...prev, [type]: text }));
  }, []);

  const save = useCallback(async () => {
    if (!allValid) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const value = {} as SchemaMap;
      for (const type of MESSAGE_TYPES) {
        const r = parsed[type];
        value[type] = r.ok ? r.value : {};
      }
      await upsertLinguisticConfig(SCHEMAS_KEY, value, 'Schema edit via admin UI');
      setStatus('Saved. The Linguistic Logic Lambda picks it up on its next cache refresh.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schemas.');
    } finally {
      setBusy(false);
    }
  }, [allValid, parsed]);

  return (
    <section className={styles.section} aria-labelledby="schemas-heading">
      <header className={styles.sectionHead}>
        <h2 id="schemas-heading" className={styles.sectionTitle}>
          Message-type schemas
        </h2>
        <span className={styles.eyebrow}>key · {SCHEMAS_KEY}</span>
      </header>
      <p className={styles.muted}>
        JSON-shaped schema definition per message type that the parser validates extracted fields
        against. Each field must be a JSON object; leave one blank for no schema. Save is blocked
        while any field holds invalid JSON. Monaco editor is deferred polish (#110) — this is a
        plain textarea with JSON validation.
      </p>

      {loading ? (
        <p className={styles.muted} role="status">
          Loading schemas…
        </p>
      ) : (
        <ul className={styles.list} data-testid="schemas-list">
          {MESSAGE_TYPES.map((type) => {
            const r = parsed[type];
            const fieldId = `schema-${type}`;
            return (
              <li key={type} className={styles.editorBlock}>
                <label className={styles.fieldLabel} htmlFor={fieldId}>
                  {type}
                </label>
                <textarea
                  id={fieldId}
                  className={styles.textarea}
                  value={drafts[type]}
                  onChange={(e) => setOne(type, e.target.value)}
                  rows={5}
                  spellCheck={false}
                  placeholder={'{ "sender": { "type": "string" } }'}
                  aria-label={`${type} schema JSON`}
                  aria-invalid={!r.ok}
                  data-testid={`schema-textarea-${type}`}
                />
                {!r.ok && (
                  <p className={styles.hintBad} role="alert" data-testid={`schema-error-${type}`}>
                    {r.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.editorActions}>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          disabled={busy || loading || !allValid}
          onClick={() => void save()}
        >
          Save schemas
        </Button>
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

function emptyDrafts(): Record<MessageType, string> {
  const out = {} as Record<MessageType, string>;
  for (const type of MESSAGE_TYPES) out[type] = '';
  return out;
}
