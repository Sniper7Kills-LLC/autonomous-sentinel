'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { getLinguisticConfig, upsertLinguisticConfig } from '@/lib/admin/linguistic';
import styles from './AdminLinguistic.module.css';

/** LinguisticConfig key holding the admin-tunable Whisper prompt (#771). */
export const WHISPER_INITIAL_PROMPT_KEY = 'WHISPER_INITIAL_PROMPT';

/**
 * Whisper initial-prompt editor (#771).
 *
 * The transcription model is primed with this text to bias it toward the
 * NATO-phonetic + EAM phraseology vocabulary (#757). Stored in the
 * `WHISPER_INITIAL_PROMPT` LinguisticConfig row; the preprocess Lambda reads
 * it and injects it into the transcribe-queue message, so the lean Whisper
 * container needs no DB client. Takes effect on the next transcription.
 *
 * Semantics:
 *   - non-empty  → that prompt is used.
 *   - empty saved → priming is DISABLED for new transcriptions.
 *   - no row yet  → the container's built-in default prompt applies.
 */
export function LinguisticWhisperPromptEditor() {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await getLinguisticConfig(WHISPER_INITIAL_PROMPT_KEY);
      setValue(typeof raw === 'string' ? raw : '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the Whisper prompt.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await upsertLinguisticConfig(
        WHISPER_INITIAL_PROMPT_KEY,
        value,
        'Whisper prompt edit via admin UI',
      );
      setStatus('Saved. New transcriptions use this prompt (existing ones are unaffected).');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the Whisper prompt.');
    } finally {
      setBusy(false);
    }
  }, [value]);

  return (
    <section className={styles.section} aria-labelledby="whisper-prompt-heading">
      <header className={styles.sectionHead}>
        <h2 id="whisper-prompt-heading" className={styles.sectionTitle}>
          Whisper initial prompt
        </h2>
        <span className={styles.eyebrow}>key · {WHISPER_INITIAL_PROMPT_KEY}</span>
      </header>
      <p className={styles.muted}>
        Primes the speech-to-text model toward EAM vocabulary (NATO phonetics + fixed phraseology).
        Saving an empty prompt disables priming; with no saved prompt the container&apos;s built-in
        default applies. Takes effect on the next transcription.
      </p>

      {loading ? (
        <p className={styles.muted} role="status">
          Loading prompt…
        </p>
      ) : (
        <textarea
          className={styles.textarea}
          rows={6}
          value={value}
          aria-label="Whisper initial prompt"
          data-testid="whisper-prompt-textarea"
          onChange={(e) => {
            setStatus(null);
            setValue(e.target.value);
          }}
        />
      )}

      <div className={styles.editorActions}>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          disabled={busy || loading}
          onClick={() => void save()}
        >
          Save prompt
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
