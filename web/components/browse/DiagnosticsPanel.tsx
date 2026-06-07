'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import { hasDiagnosticsAccess } from '@/lib/auth/roles';
import { listTracesForRecording, type DisplayTrace } from '@/lib/messages/traces';
import { diffTranscript, type DiffSegment } from '@/lib/revisions/diff';
import styles from './DiagnosticsPanel.module.css';

interface DiagnosticsPanelProps {
  recordingId: string;
}

/**
 * Linguistics deep-debug popout (#745).
 *
 * Restricted to the `diagnostics` group plus moderators + admins
 * (`hasDiagnosticsAccess`); the `LinguisticTrace` model enforces the same
 * server-side. Renders a trigger button that opens an ~80%-viewport drawer
 * and LAZY-FETCHES the recording's per-run traces (#744) on first open — no
 * network request until a privileged user actually asks for it.
 *
 * Shows, per run: the rules evaluated (which regex matched + captures), the
 * full Bedrock request/response, the proposed rules, and the final parse.
 * A "compare with" selector diffs two runs so re-runs are traceable.
 */
export function DiagnosticsPanel({ recordingId }: DiagnosticsPanelProps) {
  const { groups } = useCallerGroups();
  const [open, setOpen] = useState(false);
  const [traces, setTraces] = useState<DisplayTrace[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listTracesForRecording(recordingId);
      setTraces(rows);
      setSelectedId(rows[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load diagnostics.');
      setTraces([]);
    } finally {
      setLoading(false);
    }
  }, [recordingId]);

  useEffect(() => {
    // Lazy: only fetch the first time the drawer is opened.
    if (open && traces === null && !loading) void load();
  }, [open, traces, loading, load]);

  if (!hasDiagnosticsAccess(groups)) return null;

  const selected = traces?.find((t) => t.id === selectedId) ?? null;
  const compare = compareId ? (traces?.find((t) => t.id === compareId) ?? null) : null;

  return (
    <div className={styles.wrap}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="diagnostics-open"
      >
        Diagnostics
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="§ Linguistic Logic"
        title="Run diagnostics"
      >
        {loading && <p className={styles.muted}>Loading traces…</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {!loading && !error && traces?.length === 0 && (
          <p className={styles.muted}>
            No diagnostic traces recorded for this recording yet. Traces are captured on each
            linguistic run (reprocess to generate one).
          </p>
        )}

        {traces && traces.length > 0 && (
          <>
            <div className={styles.runBar}>
              <label className={styles.runSelect}>
                <span>Run</span>
                <select
                  value={selectedId ?? ''}
                  onChange={(e) => setSelectedId(e.target.value)}
                  data-testid="run-select"
                >
                  {traces.map((t) => (
                    <option key={t.id} value={t.id}>
                      {formatRun(t)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.runSelect}>
                <span>Compare with</span>
                <select
                  value={compareId ?? ''}
                  onChange={(e) => setCompareId(e.target.value || null)}
                  data-testid="compare-select"
                >
                  <option value="">— none —</option>
                  {traces
                    .filter((t) => t.id !== selectedId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {formatRun(t)}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {selected && !compare && <RunDetail trace={selected} />}
            {selected && compare && <RunDiff base={compare} next={selected} />}
          </>
        )}
      </Drawer>
    </div>
  );
}

function formatRun(t: DisplayTrace): string {
  const when = t.runAt ? t.runAt.slice(0, 19).replace('T', ' ') + 'Z' : '(unknown time)';
  const src = t.bedrockInvoked ? 'bedrock' : 'rules';
  return `${when} · ${src}${t.attemptSuccess === false ? ' · FAILED' : ''}`;
}

function prettyJson(v: unknown): string {
  if (v === null || v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    // JSON.stringify throws only on a circular structure here — avoid
    // String(v) (which would stringify an object to "[object Object]").
    return '[unserializable]';
  }
}

function RunDetail({ trace }: { trace: DisplayTrace }) {
  return (
    <div className={styles.detail}>
      <section>
        <h4 className={styles.heading}>Summary</h4>
        <dl className={styles.dl}>
          <dt>trigger backend</dt>
          <dd>{trace.triggerBackend ?? '—'}</dd>
          <dt>success</dt>
          <dd>{trace.attemptSuccess === null ? '—' : trace.attemptSuccess ? 'yes' : 'no'}</dd>
          <dt>truncated</dt>
          <dd>{trace.truncated ? 'yes (large fields dropped)' : 'no'}</dd>
        </dl>
        {trace.transcriptSnapshot && (
          <>
            <h5 className={styles.subheading}>Transcript parsed</h5>
            <pre className={styles.pre}>{trace.transcriptSnapshot}</pre>
          </>
        )}
      </section>

      <section>
        <h4 className={styles.heading}>Rules evaluated</h4>
        {trace.rulesEvaluated.length === 0 ? (
          <p className={styles.muted}>No rules evaluated (0-rule launch or load error).</p>
        ) : (
          <table className={styles.table} data-testid="rules-table">
            <thead>
              <tr>
                <th scope="col">rule</th>
                <th scope="col">component</th>
                <th scope="col">matched</th>
                <th scope="col">confidence</th>
                <th scope="col">captures</th>
              </tr>
            </thead>
            <tbody>
              {trace.rulesEvaluated.map((r, i) => (
                <tr key={`${r.ruleId}-${i}`} data-matched={r.matched}>
                  <td>
                    <code className={styles.code}>{r.pattern}</code>
                    <div className={styles.ruleId}>{r.ruleId}</div>
                  </td>
                  <td>{r.component ?? '—'}</td>
                  <td>{r.matched ? '✓' : '·'}</td>
                  <td>{r.confidence === null ? '—' : r.confidence.toFixed(2)}</td>
                  <td>
                    {Object.keys(r.captures).length > 0 ? (
                      <code className={styles.code}>{JSON.stringify(r.captures)}</code>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4 className={styles.heading}>Bedrock AI fallback</h4>
        {!trace.bedrockInvoked ? (
          <p className={styles.muted}>Not invoked — a rule supplied the parse.</p>
        ) : (
          <>
            <dl className={styles.dl}>
              <dt>model</dt>
              <dd>{trace.bedrockModelId ?? '—'}</dd>
              <dt>prompt version</dt>
              <dd>{trace.bedrockPromptVersion ?? '—'}</dd>
            </dl>
            <h5 className={styles.subheading}>Rendered prompt</h5>
            <pre className={styles.pre} data-testid="bedrock-prompt">
              {trace.bedrockRenderedPrompt ??
                (trace.truncated ? '(dropped — trace truncated)' : '—')}
            </pre>
            <h5 className={styles.subheading}>Raw response</h5>
            <pre className={styles.pre}>
              {trace.bedrockRawResponse === null && trace.truncated
                ? '(dropped — trace truncated)'
                : prettyJson(trace.bedrockRawResponse)}
            </pre>
            <h5 className={styles.subheading}>Proposed rules</h5>
            <pre className={styles.pre}>{prettyJson(trace.bedrockProposedRules)}</pre>
          </>
        )}
      </section>

      <section>
        <h4 className={styles.heading}>Final parse</h4>
        <pre className={styles.pre} data-testid="final-result">
          {prettyJson(trace.finalResult)}
        </pre>
      </section>
    </div>
  );
}

function RunDiff({ base, next }: { base: DisplayTrace; next: DisplayTrace }) {
  const promptDiff = diffTranscript(
    base.bedrockRenderedPrompt ?? '',
    next.bedrockRenderedPrompt ?? '',
  );
  const resultDiff = diffTranscript(prettyJson(base.finalResult), prettyJson(next.finalResult));
  return (
    <div className={styles.detail} data-testid="run-diff">
      <p className={styles.muted}>
        Comparing <strong>{formatRun(base)}</strong> → <strong>{formatRun(next)}</strong>
      </p>
      <section>
        <h4 className={styles.heading}>Final parse diff</h4>
        <pre className={styles.pre}>
          <DiffView segments={resultDiff} />
        </pre>
      </section>
      <section>
        <h4 className={styles.heading}>Bedrock prompt diff</h4>
        <pre className={styles.pre}>
          <DiffView segments={promptDiff} />
        </pre>
      </section>
    </div>
  );
}

function DiffView({ segments }: { segments: DiffSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        const mark = seg.op === 'added' ? '+' : seg.op === 'removed' ? '-' : '=';
        const key = `${i}-${mark}-${seg.value.length}`;
        if (seg.op === 'added') {
          return (
            <ins key={key} className={styles.added}>
              {seg.value}
            </ins>
          );
        }
        if (seg.op === 'removed') {
          return (
            <del key={key} className={styles.removed}>
              {seg.value}
            </del>
          );
        }
        return <span key={key}>{seg.value}</span>;
      })}
    </>
  );
}
