'use client';

import { useEffect, useState } from 'react';
import { fetchCallerGroups, isModeratorOrAdmin } from '@/lib/auth/roles';
import { listRulesForType, type DisplayRule } from '@/lib/messages/rules';
import type { DisplayRecording } from '@/lib/messages/recordings';
import type { DisplayMessage } from '@/lib/messages/types';
import styles from './MessageDetailView.module.css';

interface DebugDetailsPanelProps {
  message: DisplayMessage;
  recordings: DisplayRecording[];
}

/**
 * Moderator/admin-only "Debug details" panel (#561).
 *
 * Surfaces the raw transcript(s), the per-recording linguistic parse
 * attempts, the parsed Message fields as stored, and the LinguisticRules
 * for this message type — purely a debugging aid for "why did it parse
 * this way". Hidden entirely for members/guests; the gate mirrors the
 * recording-reprocess control (`fetchCallerGroups` → `isModeratorOrAdmin`).
 * The server enforces its own authz on every read; this only decides
 * what to render.
 */
export function DebugDetailsPanel({ message, recordings }: DebugDetailsPanelProps) {
  const [visible, setVisible] = useState(false);
  const [rules, setRules] = useState<DisplayRule[]>([]);
  const [rulesNote, setRulesNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const groups = await fetchCallerGroups();
        if (!cancelled) setVisible(isModeratorOrAdmin(groups));
      } catch {
        if (!cancelled) setVisible(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const rs = await listRulesForType(message.type);
        if (cancelled) return;
        setRules(rs);
        setRulesNote(null);
      } catch {
        if (cancelled) return;
        setRules([]);
        setRulesNote('Could not load rules (admin-only model — moderators may lack read access).');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, message.type]);

  if (!visible) return null;

  return (
    <details className={styles.debugPanel} data-testid="debug-details">
      <summary className={styles.debugSummary}>Debug details</summary>

      <div className={styles.debugBody}>
        <section aria-labelledby="dbg-transcript">
          <h4 id="dbg-transcript" className={styles.debugHeading}>
            Raw transcript
          </h4>
          {recordings.length === 0 ? (
            <p className={styles.debugEmpty}>No recordings attached.</p>
          ) : (
            recordings.map((r) => (
              <div key={r.id} className={styles.debugBlock}>
                <div className={styles.debugBlockLabel}>recording {r.id}</div>
                <div className={styles.debugBlockLabel}>
                  Transcription confidence:{' '}
                  {r.transcriptionConfidence === null ? '—' : r.transcriptionConfidence.toFixed(2)}
                </div>
                {r.transcript ? (
                  <pre className={styles.debugPre}>{r.transcript}</pre>
                ) : (
                  <p className={styles.debugEmpty}>No transcript on this recording.</p>
                )}
              </div>
            ))
          )}
        </section>

        <section aria-labelledby="dbg-attempts">
          <h4 id="dbg-attempts" className={styles.debugHeading}>
            Linguistic attempts
          </h4>
          {recordings.every((r) => r.linguisticAttempts.length === 0) ? (
            <p className={styles.debugEmpty}>No linguistic attempts recorded.</p>
          ) : (
            <table className={styles.debugTable}>
              <thead>
                <tr>
                  <th scope="col">recording</th>
                  <th scope="col">provider</th>
                  <th scope="col">success</th>
                  <th scope="col">promptVersion</th>
                  <th scope="col">ts</th>
                </tr>
              </thead>
              <tbody>
                {recordings.flatMap((r) =>
                  r.linguisticAttempts.map((a, i) => (
                    <tr key={`${r.id}-${i}`}>
                      <td>{r.id}</td>
                      <td>{a.provider ?? '—'}</td>
                      <td>{a.success === null ? '—' : a.success ? 'yes' : 'no'}</td>
                      <td>{a.promptVersion ?? '—'}</td>
                      <td>{a.ts ?? '—'}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          )}
        </section>

        <section aria-labelledby="dbg-parsed">
          <h4 id="dbg-parsed" className={styles.debugHeading}>
            Parsed fields (as stored)
          </h4>
          <dl className={styles.debugDl}>
            <dt>type</dt>
            <dd>{message.type}</dd>
            <dt>sender</dt>
            <dd>{message.sender ?? '—'}</dd>
            <dt>receiver</dt>
            <dd>{message.receiver ?? '—'}</dd>
            <dt>body</dt>
            <dd>{message.body ? <pre className={styles.debugPre}>{message.body}</pre> : '—'}</dd>
            <dt>parse confidence</dt>
            <dd>{message.confidence === null ? '—' : message.confidence.toFixed(2)}</dd>
            <dt>flaggedForReview</dt>
            <dd>{message.flaggedForReview ? 'yes' : 'no'}</dd>
          </dl>
        </section>

        <section aria-labelledby="dbg-rules">
          <h4 id="dbg-rules" className={styles.debugHeading}>
            Rules for this message type (not a per-message link)
          </h4>
          <p className={styles.debugCaveat}>
            LinguisticRules have no per-message foreign key — these are all rules whose{' '}
            <code>messageType</code> is <code>{message.type}</code>, not the exact rule(s) that
            parsed this message.
          </p>
          {rulesNote ? (
            <p className={styles.debugEmpty}>{rulesNote}</p>
          ) : rules.length === 0 ? (
            <p className={styles.debugEmpty}>No rules for this message type.</p>
          ) : (
            <table className={styles.debugTable}>
              <thead>
                <tr>
                  <th scope="col">component</th>
                  <th scope="col">pattern</th>
                  <th scope="col">confidence</th>
                  <th scope="col">enabled</th>
                  <th scope="col">appliesToType</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.component ?? 'TYPE'}</td>
                    <td>
                      <code className={styles.debugCode}>{rule.pattern}</code>
                    </td>
                    <td>{rule.confidence === null ? '—' : rule.confidence.toFixed(2)}</td>
                    <td>{rule.enabled ? 'yes' : 'no'}</td>
                    <td>{rule.appliesToType ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </details>
  );
}
