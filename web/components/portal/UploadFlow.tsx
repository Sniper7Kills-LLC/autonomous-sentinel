'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadData } from 'aws-amplify/storage';
import type { Subscription } from 'rxjs';
import { getDataClient } from '@/lib/amplifyClient';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { StatusPill, type PipelineStatus } from '@/components/ui/StatusPill';
import styles from './UploadFlow.module.css';

const PIPELINE_STAGES: PipelineStatus[] = [
  'queued',
  'preprocessing',
  'transcribing',
  'parsing',
  'published',
];

/**
 * Map the server-side `Recording.transcriptionStatus` enum to the
 * `StatusPill` visual states the component library exposes. The
 * `*_FAILED` granular variants collapse to the `failed` pill — the
 * RawLog panel below surfaces the precise enum value for debugging.
 */
function toPill(status: string | null | undefined): PipelineStatus | null {
  switch (status) {
    case 'QUEUED':
      return 'queued';
    case 'PREPROCESSING':
      return 'preprocessing';
    case 'PREPROCESS_FAILED':
      return 'failed';
    case 'TRANSCRIBING':
      return 'transcribing';
    case 'TRANSCRIBE_FAILED':
      return 'failed';
    case 'PARSING':
      return 'parsing';
    case 'PARSE_FAILED':
      return 'failed';
    case 'PUBLISHED':
      return 'published';
    case 'FAILED':
      return 'failed';
    default:
      return null;
  }
}

type LogEntry = {
  ts: string;
  label: string;
  payload: unknown;
};

interface UploadFlowProps {
  onLog: (entry: LogEntry) => void;
}

export function UploadFlow({ onLog }: UploadFlowProps) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<
    'idle' | 'hashing' | 'uploading' | 'submitting' | 'tracking' | 'done' | 'error'
  >('idle');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [serverStatus, setServerStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const subRef = useRef<Subscription | null>(null);

  useEffect(
    () => () => {
      subRef.current?.unsubscribe();
    },
    [],
  );

  const reset = useCallback(() => {
    subRef.current?.unsubscribe();
    subRef.current = null;
    setFile(null);
    setPhase('idle');
    setRecordingId(null);
    setStatus(null);
    setServerStatus(null);
    setError(null);
    setProgress(0);
  }, []);

  const start = useCallback(async () => {
    if (!file) return;
    setError(null);
    setStatus(null);
    setRecordingId(null);
    onLog({
      ts: new Date().toISOString(),
      label: 'upload.start',
      payload: { name: file.name, size: file.size, type: file.type },
    });

    try {
      // ----- 1. Content hash (SHA-256, hex) ----------------------------
      setPhase('hashing');
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const contentHash = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      onLog({
        ts: new Date().toISOString(),
        label: 'upload.hashed',
        payload: { contentHash },
      });

      // ----- 2. S3 upload to recordings/originals/{hash}{ext} ----------
      setPhase('uploading');
      const ext = extensionFromMimeOrName(file);
      const originalKey = `recordings/originals/${contentHash}${ext}`;
      await uploadData({
        path: originalKey,
        data: file,
        options: {
          contentType: file.type || undefined,
          onProgress: ({ transferredBytes, totalBytes }) => {
            if (totalBytes) {
              setProgress(Math.round((transferredBytes / totalBytes) * 100));
            }
          },
        },
      }).result;
      onLog({
        ts: new Date().toISOString(),
        label: 's3.uploaded',
        payload: { originalKey },
      });

      // ----- 3. submitRecording mutation -------------------------------
      //
      // Default `authorizationMode` on the data resource is
      // `identityPool` (IAM-signed via Cognito Identity Pool). The
      // mutation is allowed for any signed-in user (`allow.authenticated()`
      // + `allow.groups([...])`), but the IAM check only inspects the
      // policy attached to the caller's Identity Pool role — admin /
      // moderator / member users route to per-group roles that have
      // no `appsync:GraphQL` grant for this resolver. Override the
      // call to `userPool` so AppSync uses the User Pool JWT path,
      // which honours the group rule.
      setPhase('submitting');
      const client = getDataClient();
      const result = await client.mutations.submitRecording(
        { contentHash, originalKey },
        { authMode: 'userPool' },
      );
      onLog({
        ts: new Date().toISOString(),
        label: 'graphql.submitRecording',
        payload: result,
      });

      if (result.errors?.length) {
        const messages = result.errors.map((e) => e.message).join('; ');
        throw new Error(messages || 'submitRecording failed');
      }

      const created = result.data;
      if (!created?.id) {
        throw new Error('submitRecording returned no Recording id');
      }
      setRecordingId(created.id);
      setServerStatus(created.transcriptionStatus ?? 'QUEUED');
      setStatus(toPill(created.transcriptionStatus ?? 'QUEUED'));

      // ----- 4. Subscribe to status updates ----------------------------
      setPhase('tracking');
      // Same userPool override as the mutation above — the Recording
      // model's read rule is also `allow.authenticated()` + group rules
      // and only the userPool path honours the group membership claim.
      subRef.current = client.models.Recording.observeQuery({
        filter: { id: { eq: created.id } },
        authMode: 'userPool',
      }).subscribe({
        next: ({ items }) => {
          const r = items[0];
          if (!r) return;
          const next = r.transcriptionStatus ?? null;
          setServerStatus(next);
          setStatus(toPill(next));
          onLog({
            ts: new Date().toISOString(),
            label: 'subscription.update',
            payload: {
              id: r.id,
              transcriptionStatus: next,
              transcript: r.transcript ?? null,
              failedReason: r.failedReason ?? null,
            },
          });
          if (next === 'PUBLISHED' || next === 'FAILED') {
            subRef.current?.unsubscribe();
            subRef.current = null;
            setPhase('done');
          }
        },
        error: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setPhase('error');
          onLog({
            ts: new Date().toISOString(),
            label: 'subscription.error',
            payload: { message: msg },
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase('error');
      onLog({
        ts: new Date().toISOString(),
        label: 'upload.error',
        payload: { message: msg },
      });
    }
  }, [file, onLog]);

  return (
    <div className={styles.root}>
      <DropZone
        onSelect={setFile}
        disabled={phase !== 'idle' && phase !== 'done' && phase !== 'error'}
        file={file}
      />

      <div className={styles.controls}>
        <Button
          onClick={() => {
            void start();
          }}
          disabled={!file || (phase !== 'idle' && phase !== 'done' && phase !== 'error')}
          loading={phase === 'hashing' || phase === 'uploading' || phase === 'submitting'}
        >
          {phase === 'idle' || phase === 'done' || phase === 'error'
            ? 'Run pipeline'
            : phaseLabel(phase, progress)}
        </Button>
        {(phase === 'done' || phase === 'error') && (
          <Button variant="ghost" onClick={reset}>
            Reset
          </Button>
        )}
        {recordingId && (
          <span className={styles.recId}>
            Recording: <code>{recordingId}</code>
          </span>
        )}
      </div>

      {phase === 'uploading' && (
        <div className={styles.progressBar} aria-label="Upload progress">
          <span className={styles.progressFill} style={{ width: `${progress}%` }} />
          <span className={styles.progressLabel}>{progress}%</span>
        </div>
      )}

      <Timeline current={status} serverStatus={serverStatus} />

      {error && (
        <Alert tone="danger" title="Pipeline error">
          {error}
        </Alert>
      )}
    </div>
  );
}

function Timeline({
  current,
  serverStatus,
}: {
  current: PipelineStatus | null;
  serverStatus: string | null;
}) {
  const reachedIdx = current ? PIPELINE_STAGES.findIndex((s) => s === current) : -1;
  return (
    <div className={styles.timeline}>
      {PIPELINE_STAGES.map((stage, i) => {
        const isCurrent = current === stage;
        const isPast = reachedIdx >= 0 && i < reachedIdx;
        // Failure renders as its own pill after the stage list (below).
        // Stages themselves stay in past/current/future to keep the
        // visual flow readable when something blows up mid-pipeline.
        const klass = isCurrent
          ? styles.stageCurrent
          : isPast
            ? styles.stagePast
            : styles.stageFuture;
        return (
          <div key={stage} className={`${styles.stage} ${klass}`}>
            <StatusPill status={stage} pulse={isCurrent} />
          </div>
        );
      })}
      {current === 'failed' && (
        <div className={`${styles.stage} ${styles.stageFailed}`}>
          <StatusPill status="failed" />
        </div>
      )}
      {serverStatus && (
        <div className={styles.serverStatus}>
          Server: <code>{serverStatus}</code>
        </div>
      )}
    </div>
  );
}

interface DropZoneProps {
  onSelect: (file: File | null) => void;
  disabled: boolean;
  file: File | null;
}

function DropZone({ onSelect, disabled, file }: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`${styles.dropZone} ${dragOver ? styles.dropZoneOver : ''} ${
        disabled ? styles.dropZoneDisabled : ''
      }`}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onSelect(f);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.opus,.flac,.m4a,.ogg"
        className={styles.fileInput}
        aria-label="Choose an audio file to upload"
        onChange={(e) => onSelect(e.target.files?.[0] ?? null)}
        disabled={disabled}
      />
      {file ? (
        <div className={styles.fileInfo}>
          <span className={styles.fileLabel}>SELECTED</span>
          <span className={styles.fileName}>{file.name}</span>
          <span className={styles.fileMeta}>
            {formatBytes(file.size)} · {file.type || 'audio/*'}
          </span>
        </div>
      ) : (
        <div className={styles.dropPrompt}>
          <span className={styles.dropEyebrow}>STEP 01</span>
          <span className={styles.dropHeading}>Drop an audio capture</span>
          <span className={styles.dropHint}>
            .wav · .mp3 · .opus · .flac · .ogg · .m4a — anything pre-process accepts
          </span>
        </div>
      )}
    </div>
  );
}

function phaseLabel(
  phase: 'hashing' | 'uploading' | 'submitting' | 'tracking' | 'done' | 'error' | 'idle',
  progress: number,
): string {
  switch (phase) {
    case 'hashing':
      return 'Hashing…';
    case 'uploading':
      return `Uploading ${progress}%`;
    case 'submitting':
      return 'Submitting…';
    case 'tracking':
      return 'Tracking…';
    default:
      return 'Run pipeline';
  }
}

function extensionFromMimeOrName(f: File): string {
  const dot = f.name.lastIndexOf('.');
  if (dot > -1) return f.name.slice(dot).toLowerCase();
  if (f.type === 'audio/mpeg') return '.mp3';
  if (f.type === 'audio/wav') return '.wav';
  if (f.type === 'audio/ogg') return '.ogg';
  if (f.type === 'audio/flac') return '.flac';
  return '.bin';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
