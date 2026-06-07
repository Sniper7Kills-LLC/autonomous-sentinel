'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { StatusPill, type PipelineStatus } from '@/components/ui/StatusPill';
import {
  listMyUploads,
  observeMyUploads,
  statusToStage,
  type UploadRow,
  type UploadStage,
} from '@/lib/uploads/query';
import { reprocessRecording } from '@/lib/uploads/reprocess';
import { isModeratorOrAdmin } from '@/lib/auth/roles';
import { useCallerGroups } from '@/components/auth/AuthProvider';
import styles from './UploadsList.module.css';

interface UploadsListProps {
  uploaderId: string;
}

/**
 * Extract a human message from an arbitrary thrown/emitted value. AppSync
 * subscription errors are plain objects (not `Error`), so a bare `String(e)`
 * renders "[object Object]" (#774 follow-up). Digs the common GraphQL shapes.
 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; error?: unknown; errors?: unknown };
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (Array.isArray(o.errors)) {
      const msgs = o.errors
        .map((x) => (x && typeof x === 'object' ? (x as { message?: unknown }).message : null))
        .filter((m): m is string => typeof m === 'string');
      if (msgs.length) return msgs.join('; ');
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return 'Unknown error';
}

/**
 * `My Uploads` list (#94, live #774).
 *
 * Lists every Recording the caller has uploaded with its current pipeline
 * stage, upload time + broadcast time. An initial one-shot `listMyUploads`
 * paints reliably; an AppSync `observeQuery` subscription then layers LIVE
 * status updates on top (best-effort — a subscription error only logs, never
 * blanks the page). Failed rows highlight in red + surface `failedReason`.
 */
export function UploadsList({ uploaderId }: UploadsListProps) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Moderators/admins get a per-row "Reprocess" control (#505). The
  // mutation is authz-gated server-side too — this only decides
  // whether to render the button.
  const { groups } = useCallerGroups();
  const canReprocess = isModeratorOrAdmin(groups);

  // Live subscription (#774): the synced snapshot reflects the server-side
  // QUEUED reset after a reprocess + every subsequent stage transition, so
  // the mutation just fires and the query carries the row forward.
  const handleReprocess = useCallback(async (recordingId: string) => {
    await reprocessRecording(recordingId);
  }, []);

  useEffect(() => {
    let active = true;
    // Whether the live subscription has delivered a snapshot yet. Once it
    // has, the (possibly later-resolving) initial list must not clobber the
    // fresher live data.
    let liveDelivered = false;
    setLoading(true);
    setError(null);

    // Reliable first paint via a one-shot list — this is what the page used
    // before the live layer, and it works even when the realtime subscription
    // can't open (the source of the "[object Object]" banner, #774 follow-up).
    void listMyUploads(uploaderId)
      .then((res) => {
        if (active && !liveDelivered) {
          setRows(res.items);
          setLoading(false);
        }
      })
      .catch((e) => {
        // Only surface a banner when the live layer hasn't already painted.
        if (active && !liveDelivered) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });

    // Live updates layered on top — best-effort. A subscription error must
    // NOT blank the page (the list already painted), so it only logs.
    let sub: { unsubscribe: () => void } | undefined;
    try {
      sub = observeMyUploads(uploaderId, {
        next: (next) => {
          if (active) {
            liveDelivered = true;
            setRows(next);
            setLoading(false);
            setError(null);
          }
        },
        error: (err) => {
          console.warn('UploadsList: live updates unavailable (showing last list)', err);
        },
      });
    } catch (err) {
      console.warn('UploadsList: could not start live updates', err);
    }

    return () => {
      active = false;
      sub?.unsubscribe();
    };
  }, [uploaderId]);

  if (loading) {
    return (
      <div className={styles.notice} aria-busy>
        Loading your uploads…
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.error} role="alert">
        Could not load uploads: {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={styles.empty}>
        No uploads yet. Drop a recording in the{' '}
        <Link href="/portal" className={styles.link}>
          testing portal
        </Link>{' '}
        to get started.
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <div className={styles.headRow}>
        <span className={styles.count}>
          {rows.length} upload{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      {rows.map((row) => (
        <UploadRowItem
          key={row.id}
          row={row}
          canReprocess={canReprocess}
          onReprocess={handleReprocess}
        />
      ))}
    </div>
  );
}

interface UploadRowItemProps {
  row: UploadRow;
  canReprocess: boolean;
  onReprocess: (recordingId: string) => Promise<void>;
}

function UploadRowItem({ row, canReprocess, onReprocess }: UploadRowItemProps) {
  const stage = statusToStage(row.transcriptionStatus);
  const isFailed = stage.endsWith('_failed') || stage === 'failed';
  const pillStatus = mapToPill(stage);
  const granularLabel = humanStage(stage);
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessError, setReprocessError] = useState<string | null>(null);
  // Guard against state updates after unmount (row removed / navigation
  // away while the mutation is in flight).
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A recording-less row has no stored audio to reprocess; the server
  // rejects it too, but hide the control rather than offer a dead button.
  const reprocessable = canReprocess && Boolean(row.originalKey);

  const doReprocess = useCallback(async () => {
    setReprocessing(true);
    setReprocessError(null);
    try {
      await onReprocess(row.id);
    } catch (err) {
      if (mountedRef.current) setReprocessError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setReprocessing(false);
    }
  }, [onReprocess, row.id]);
  return (
    <article
      className={`${styles.row} ${isFailed ? styles.rowFailed : ''}`}
      data-recording-id={row.id}
      data-stage={stage}
    >
      <div className={styles.rowBody}>
        <div className={styles.rowHead}>
          <span className={styles.idMono} title={row.id}>
            {shortId(row.id)}
          </span>
          {row.createdAt && (
            <span className={styles.tag} title={row.createdAt}>
              Uploaded {formatTs(row.createdAt)}
            </span>
          )}
          {row.broadcastedAt && (
            <span className={styles.tag} title={row.broadcastedAt}>
              Broadcast {formatTs(row.broadcastedAt)}
            </span>
          )}
        </div>
        <div className={styles.rowMeta}>
          {typeof row.frequencyKhz === 'number' && (
            <span className={styles.tag}>
              {(row.frequencyKhz / 1000).toFixed(3)} MHz
              {row.modulation ? ` · ${row.modulation}` : ''}
            </span>
          )}
          {row.durationMs && (
            <span className={styles.tag}>{Math.round(row.durationMs / 1000)}s</span>
          )}
          {row.automated && <span className={styles.tag}>AUTOMATED</span>}
          {granularLabel !== pillStatus && <span className={styles.tag}>{granularLabel}</span>}
        </div>
        {isFailed && row.failedReason && <div className={styles.error}>{row.failedReason}</div>}
      </div>
      <div className={styles.rowRight}>
        <StatusPill status={pillStatus} />
        <div className={styles.linkRow}>
          {row.messageId && (
            <Link
              className={styles.link}
              href={`/messages/view?id=${encodeURIComponent(row.messageId)}`}
            >
              Open message →
            </Link>
          )}
          {reprocessable && (
            <Button
              variant="ghost"
              size="sm"
              loading={reprocessing}
              disabled={reprocessing}
              onClick={() => {
                void doReprocess();
              }}
            >
              Reprocess
            </Button>
          )}
        </div>
        {reprocessError && (
          <div className={styles.error} role="alert">
            Reprocess failed: {reprocessError}
          </div>
        )}
      </div>
    </article>
  );
}

function mapToPill(stage: UploadStage): PipelineStatus {
  switch (stage) {
    case 'queued':
      return 'queued';
    case 'preprocessing':
      return 'preprocessing';
    case 'transcribing':
      return 'transcribing';
    case 'parsing':
      return 'parsing';
    case 'published':
      return 'published';
    case 'preprocess_failed':
    case 'transcribe_failed':
    case 'parse_failed':
    case 'failed':
      return 'failed';
    default:
      return 'queued';
  }
}

function humanStage(stage: UploadStage): string {
  switch (stage) {
    case 'preprocess_failed':
      return 'preprocess failed';
    case 'transcribe_failed':
      return 'transcribe failed';
    case 'parse_failed':
      return 'parse failed';
    case 'unknown':
      return 'unknown';
    default:
      return stage;
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}
