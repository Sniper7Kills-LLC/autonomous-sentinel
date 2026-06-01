'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { StatusPill, type PipelineStatus } from '@/components/ui/StatusPill';
import {
  listMyUploads,
  statusToStage,
  type UploadRow,
  type UploadStage,
} from '@/lib/uploads/query';
import { reprocessRecording } from '@/lib/uploads/reprocess';
import { fetchCallerGroups, isModeratorOrAdmin } from '@/lib/auth/roles';
import styles from './UploadsList.module.css';

interface UploadsListProps {
  uploaderId: string;
}

/**
 * `My Uploads` list (#94).
 *
 * Lists every Recording the caller has uploaded with its current
 * pipeline stage. Failed rows highlight in red and surface
 * `failedReason` inline for debugging.
 *
 * Pagination via the AppSync `nextToken`; "Load more" appends to the
 * existing list rather than replacing it.
 */
export function UploadsList({ uploaderId }: UploadsListProps) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Moderators/admins get a per-row "Reprocess" control (#505). The
  // mutation is authz-gated server-side too — this only decides
  // whether to render the button.
  const [canReprocess, setCanReprocess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const groups = await fetchCallerGroups();
        if (!cancelled) setCanReprocess(isModeratorOrAdmin(groups));
      } catch {
        if (!cancelled) setCanReprocess(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleReprocess = useCallback(async (recordingId: string) => {
    await reprocessRecording(recordingId);
    // Reflect the server-side reset to QUEUED + cleared failure so the
    // row updates immediately; the pipeline subscription / next reload
    // will carry it forward from there.
    setRows((prev) =>
      prev.map((r) =>
        r.id === recordingId
          ? { ...r, transcriptionStatus: 'QUEUED', transcriptionFailed: false, failedReason: null }
          : r,
      ),
    );
  }, []);

  const load = useCallback(
    async (token: string | null) => {
      try {
        if (!token) setLoading(true);
        else setLoadingMore(true);
        setError(null);
        const page = await listMyUploads(uploaderId, { nextToken: token });
        setRows((prev) => (token ? [...prev, ...page.items] : page.items));
        setNextToken(page.nextToken);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [uploaderId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

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
      {nextToken && (
        <div className={styles.headRow} style={{ justifyContent: 'center' }}>
          <Button
            variant="ghost"
            size="sm"
            loading={loadingMore}
            disabled={loadingMore}
            onClick={() => {
              void load(nextToken);
            }}
          >
            Load more
          </Button>
        </div>
      )}
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
          {row.broadcastedAt && <span>{formatTs(row.broadcastedAt)}</span>}
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
            <Link className={styles.link} href={`/messages/${encodeURIComponent(row.messageId)}`}>
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
