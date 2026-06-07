'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import { hasDiagnosticsAccess, isAdmin } from '@/lib/auth/roles';
import {
  listTracesForRecording,
  fetchTraceOverflow,
  type DisplayTrace,
} from '@/lib/messages/traces';
import { listRules, setRuleEnabled } from '@/lib/admin/linguistic';
import {
  findCallsignByNormalized,
  approveCallsign,
  deleteCallsign,
  type CallsignRow,
} from '@/lib/admin/callsigns';
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
  // Admin-only (#746): live enabled-state of LinguisticRules, keyed by id,
  // so the rules table can toggle each rule. null until fetched / for
  // non-admins (who never see the toggle).
  const [ruleEnabled, setRuleEnabledState] = useState<Record<string, boolean> | null>(null);

  const admin = isAdmin(groups);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listTracesForRecording(recordingId);
      setTraces(rows);
      setSelectedId(rows[0]?.id ?? null);
      // Admin-only: fetch current rule enabled-state for the inline toggle.
      // Best-effort — a failure just leaves the toggles hidden, never blocks
      // the (already-loaded) trace view.
      if (admin) {
        try {
          const rules = await listRules();
          setRuleEnabledState(Object.fromEntries(rules.map((r) => [r.id, r.enabled])));
        } catch {
          setRuleEnabledState(null);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load diagnostics.');
      setTraces([]);
    } finally {
      setLoading(false);
    }
  }, [recordingId, admin]);

  const toggleRule = useCallback((ruleId: string, next: boolean) => {
    // Optimistic flip; revert on failure. Fire-and-forget so the handler
    // matches the void-returning onToggleRule prop (no floating promise in a
    // JSX attribute).
    setRuleEnabledState((m) => (m ? { ...m, [ruleId]: next } : m));
    void setRuleEnabled(ruleId, next).catch(() => {
      setRuleEnabledState((m) => (m ? { ...m, [ruleId]: !next } : m));
    });
  }, []);

  useEffect(() => {
    // Lazy: only fetch the first time the drawer is opened.
    if (open && traces === null && !loading) void load();
  }, [open, traces, loading, load]);

  if (!hasDiagnosticsAccess(groups)) return null;

  const selected = traces?.find((t) => t.id === selectedId) ?? null;
  // Guard against a stale `compareId` equal to the current `selectedId`
  // (e.g. compare B chosen, then the run selector switched to B): never
  // diff a run against itself.
  const compare =
    compareId && compareId !== selectedId
      ? (traces?.find((t) => t.id === compareId) ?? null)
      : null;

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

        {admin && (
          <p className={styles.muted}>
            Admin: toggle a rule below, or open the{' '}
            <Link href="/admin/linguistic" className={styles.link}>
              Linguistic Logic config
            </Link>{' '}
            for thresholds, schemas + the Bedrock prompt.
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

            {selected && !compare && (
              <RunDetail
                trace={selected}
                admin={admin}
                ruleEnabled={ruleEnabled}
                onToggleRule={toggleRule}
              />
            )}
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

/**
 * Renders a large trace field: the inline value when present, or — when the
 * field was spilled to S3 by the size guard (#749) — a button that fetches
 * the blob on demand via a signed URL. Falls back to a dropped-marker when
 * the field was truncated without a spill (no bucket configured).
 */
function OverflowField({
  inline,
  overflowKey,
  testId,
}: {
  inline: string | null;
  overflowKey?: string;
  testId: string;
}) {
  const [fetched, setFetched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (inline !== null) {
    return (
      <pre className={styles.pre} data-testid={testId}>
        {inline}
      </pre>
    );
  }

  if (fetched !== null) {
    return (
      <pre className={styles.pre} data-testid={testId}>
        {fetched}
      </pre>
    );
  }

  if (!overflowKey) {
    return (
      <pre className={styles.pre} data-testid={testId}>
        (dropped — trace truncated, no spill bucket)
      </pre>
    );
  }

  return (
    <div data-testid={testId}>
      <p className={styles.muted}>This field was offloaded to S3 (large trace).</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={loading}
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setError(null);
          fetchTraceOverflow(overflowKey)
            .then(setFetched)
            .catch((e: unknown) =>
              setError(e instanceof Error ? e.message : 'Failed to load from S3.'),
            )
            .finally(() => setLoading(false));
        }}
      >
        Load from S3
      </Button>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function RunDetail({
  trace,
  admin,
  ruleEnabled,
  onToggleRule,
}: {
  trace: DisplayTrace;
  admin: boolean;
  ruleEnabled: Record<string, boolean> | null;
  onToggleRule: (ruleId: string, next: boolean) => void;
}) {
  // Show the admin toggle column only when we have live rule state to act on.
  const showToggle = admin && ruleEnabled !== null;
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
                {showToggle && <th scope="col">enabled</th>}
              </tr>
            </thead>
            <tbody>
              {trace.rulesEvaluated.map((r, i) => {
                // Default to enabled: the engine only evaluates enabled rules,
                // so a rule present in the trace was on at run time. A rule
                // deleted since won't be in the map → no toggle for that row.
                const known = ruleEnabled !== null && r.ruleId in ruleEnabled;
                const on = ruleEnabled?.[r.ruleId] ?? true;
                return (
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
                    {showToggle && (
                      <td>
                        {known ? (
                          <Button
                            type="button"
                            variant={on ? 'secondary' : 'primary'}
                            size="sm"
                            data-testid={`rule-toggle-${r.ruleId}`}
                            onClick={() => onToggleRule(r.ruleId, !on)}
                          >
                            {on ? 'Disable' : 'Enable'}
                          </Button>
                        ) : (
                          <span className={styles.ruleId}>deleted</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
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
            <OverflowField
              inline={trace.bedrockRenderedPrompt}
              overflowKey={trace.overflowKeys.renderedPrompt}
              testId="bedrock-prompt"
            />
            <h5 className={styles.subheading}>Raw response</h5>
            <OverflowField
              inline={
                trace.bedrockRawResponse === null ? null : prettyJson(trace.bedrockRawResponse)
              }
              overflowKey={trace.overflowKeys.rawResponse}
              testId="bedrock-response"
            />
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

      <CallsignReview trace={trace} admin={admin} />
    </div>
  );
}

/** Receivers that are NOT callsigns — never offer to confirm these (#777). */
const NON_CALLSIGN = new Set(['ALL STATIONS', 'ALLSTATIONS', 'ALL STATION']);

/**
 * Distinct, normalized sender/receiver callsigns from a run's final parse.
 * Mirrors the pipeline's `callsignCandidates` so the panel reviews exactly
 * the callsigns the linguistic stage would have auto-suggested (#776/#777).
 */
function callsignsFromResult(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as { sender?: unknown; receiver?: unknown };
  const out: string[] = [];
  for (const raw of [r.sender, r.receiver]) {
    if (typeof raw !== 'string') continue;
    const n = raw.trim().toUpperCase();
    if (!n || NON_CALLSIGN.has(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

interface CallsignState {
  loading: boolean;
  row: CallsignRow | null;
  removed: boolean;
  busy: boolean;
  error: string | null;
}

const PENDING_STATE: CallsignState = {
  loading: true,
  row: null,
  removed: false,
  busy: false,
  error: null,
};

/**
 * Confirm/reject the parse's suggested callsigns (#777).
 *
 * On run selection, looks up each sender/receiver callsign in the dictionary.
 * Admins get Confirm (approve → `approved=true`) / Reject (delete) controls on
 * any `AI_SUGGESTED`, not-yet-approved row — exactly the rows the pipeline
 * auto-created from this parse. Non-admins (diagnostics/moderator) see the
 * dictionary state read-only. The `Callsign` model enforces admin-only writes
 * server-side regardless.
 */
function CallsignReview({ trace, admin }: { trace: DisplayTrace; admin: boolean }) {
  const candidates = useMemo(() => callsignsFromResult(trace.finalResult), [trace.finalResult]);
  const [state, setState] = useState<Record<string, CallsignState>>({});
  // A monotonic "generation" bumped whenever the reviewed run changes. Every
  // async settle (lookup, confirm, reject) captures the generation it started
  // in and only applies its setState if still current — so a late completion
  // from a previous run never clobbers the freshly-loaded state (race on a
  // quick run switch, including the same callsign appearing in both runs).
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current += 1;
    const gen = genRef.current;
    if (candidates.length === 0) {
      setState({});
      return;
    }
    setState(Object.fromEntries(candidates.map((c) => [c, PENDING_STATE])));
    for (const c of candidates) {
      findCallsignByNormalized(c)
        .then((row) => {
          if (genRef.current === gen)
            setState((s) => ({ ...s, [c]: { ...(s[c] ?? PENDING_STATE), loading: false, row } }));
        })
        .catch(() => {
          if (genRef.current === gen)
            setState((s) => ({
              ...s,
              [c]: { ...(s[c] ?? PENDING_STATE), loading: false, row: null },
            }));
        });
    }
  }, [candidates]);

  const confirm = useCallback((c: string, id: string) => {
    const gen = genRef.current;
    setState((s) => ({ ...s, [c]: { ...(s[c] ?? PENDING_STATE), busy: true, error: null } }));
    approveCallsign(id)
      .then((row) => {
        if (genRef.current === gen)
          setState((s) => ({ ...s, [c]: { ...(s[c] ?? PENDING_STATE), busy: false, row } }));
      })
      .catch((e: unknown) => {
        if (genRef.current === gen)
          setState((s) => ({
            ...s,
            [c]: {
              ...(s[c] ?? PENDING_STATE),
              busy: false,
              error: e instanceof Error ? e.message : 'Confirm failed.',
            },
          }));
      });
  }, []);

  const reject = useCallback((c: string, id: string) => {
    const gen = genRef.current;
    setState((s) => ({ ...s, [c]: { ...(s[c] ?? PENDING_STATE), busy: true, error: null } }));
    deleteCallsign(id)
      .then(() => {
        if (genRef.current === gen)
          setState((s) => ({
            ...s,
            [c]: { ...(s[c] ?? PENDING_STATE), busy: false, removed: true, row: null },
          }));
      })
      .catch((e: unknown) => {
        if (genRef.current === gen)
          setState((s) => ({
            ...s,
            [c]: {
              ...(s[c] ?? PENDING_STATE),
              busy: false,
              error: e instanceof Error ? e.message : 'Reject failed.',
            },
          }));
      });
  }, []);

  if (candidates.length === 0) return null;

  return (
    <section data-testid="callsign-review">
      <h4 className={styles.heading}>Callsigns</h4>
      <ul className={styles.callsignList}>
        {candidates.map((c) => {
          const st = state[c] ?? PENDING_STATE;
          const pending = st.row !== null && st.row.source === 'AI_SUGGESTED' && !st.row.approved;
          return (
            <li key={c} className={styles.callsignChip} data-testid={`callsign-chip-${c}`}>
              <code className={styles.code}>{c}</code>
              <span className={styles.callsignState} data-testid={`callsign-state-${c}`}>
                {st.loading
                  ? 'checking…'
                  : st.removed
                    ? 'rejected'
                    : st.row === null
                      ? 'not in dictionary'
                      : pending
                        ? 'suggested — pending review'
                        : 'in dictionary'}
              </span>
              {admin && pending && st.row && (
                <span className={styles.callsignActions}>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    loading={st.busy}
                    disabled={st.busy}
                    data-testid={`callsign-confirm-${c}`}
                    onClick={() => confirm(c, st.row!.id)}
                  >
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    loading={st.busy}
                    disabled={st.busy}
                    data-testid={`callsign-reject-${c}`}
                    onClick={() => reject(c, st.row!.id)}
                  >
                    Reject
                  </Button>
                </span>
              )}
              {st.error && (
                <span className={styles.error} role="alert">
                  {st.error}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
