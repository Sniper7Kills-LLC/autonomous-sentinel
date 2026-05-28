'use client';

import { useEffect, useState } from 'react';
import { Badge, MessageTypeBadge } from '@/components/ui/Badge';
import { AudioPlayer } from '@/components/player/AudioPlayer';
import { getMessage } from '@/lib/messages/query';
import { listRecordingsForMessage, type DisplayRecording } from '@/lib/messages/recordings';
import type { DisplayMessage } from '@/lib/messages/types';
import styles from './MessageDetailView.module.css';

interface MessageDetailViewProps {
  messageId: string;
}

export function MessageDetailView({ messageId }: MessageDetailViewProps) {
  const [message, setMessage] = useState<DisplayMessage | null>(null);
  const [recordings, setRecordings] = useState<DisplayRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getMessage(messageId), listRecordingsForMessage(messageId)])
      .then(([m, rs]) => {
        if (cancelled) return;
        setMessage(m);
        setRecordings(rs);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  if (loading) {
    return (
      <div className={styles.notFound} aria-busy>
        Loading message…
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.notFound} role="alert">
        Could not load message: {error}
      </div>
    );
  }

  if (!message) {
    return <div className={styles.notFound}>Message not found.</div>;
  }

  return (
    <div className={styles.shell}>
      <section className={styles.metaCard} aria-labelledby="msg-title">
        <div className={styles.metaTop}>
          <MessageTypeBadge type={message.type} />
          <span style={{ fontFamily: 'var(--font-jb-mono)', fontSize: '0.85rem' }}>
            {formatTs(message.broadcastTs)}
          </span>
          <span className={styles.spacer} />
          {message.flaggedForReview && <Badge tone="warn">FLAGGED</Badge>}
          {typeof message.confidence === 'number' && (
            <Badge tone={confidenceTone(message.confidence)}>
              CONF {message.confidence.toFixed(2)}
            </Badge>
          )}
        </div>
        <h2 id="msg-title" className={styles.metaCallsigns}>
          {message.sender && <span className={styles.callsign}>{message.sender}</span>}
          {message.sender && message.receiver && (
            <span className={styles.arrow} aria-hidden>
              →
            </span>
          )}
          {message.receiver && <span className={styles.callsign}>{message.receiver}</span>}
        </h2>
        {message.body && <pre className={styles.body}>{message.body}</pre>}
      </section>

      <section aria-labelledby="recs-title">
        <div className={styles.recordingsHeader}>
          <h3 id="recs-title" className={styles.recordingsHeading}>
            Attached recordings
          </h3>
          <span className={styles.recordingsCount}>
            {recordings.length} recording{recordings.length === 1 ? '' : 's'}
          </span>
        </div>
        {recordings.length === 0 ? (
          <div className={styles.notFound}>
            No recordings attached. Recording-less Messages and v3-archive entries land without
            audio.
          </div>
        ) : (
          <div className={styles.recordingList}>
            {recordings.map((r) => (
              <article
                key={r.id}
                id={`recording-${r.id}`}
                className={styles.recCard}
                data-status={r.transcriptionStatus ?? 'UNKNOWN'}
              >
                <div className={styles.recTop}>
                  {typeof r.frequencyKhz === 'number' && (
                    <span className={styles.freqChip}>
                      {(r.frequencyKhz / 1000).toFixed(3)} MHz
                      {r.modulation ? ` · ${r.modulation}` : ''}
                    </span>
                  )}
                  {r.broadcastedAt && <span>{formatTs(r.broadcastedAt)}</span>}
                  {r.automated && <Badge tone="info">AUTOMATED</Badge>}
                  <span className={styles.spacer} />
                  {r.transcriptionStatus && (
                    <Badge tone={r.transcriptionStatus === 'PUBLISHED' ? 'success' : 'neutral'}>
                      {r.transcriptionStatus}
                    </Badge>
                  )}
                </div>
                {r.webCanonicalKey ? (
                  <AudioPlayer
                    recordingId={r.id}
                    webCanonicalKey={r.webCanonicalKey}
                    peaksJsonKey={r.peaksJsonKey}
                    wordTimestampsKey={r.wordTimestampsKey}
                    transcript={r.transcript}
                  />
                ) : (
                  <div className={styles.playerPlaceholder} aria-label="Audio not yet ready">
                    Audio still processing — check back after the pipeline finishes.
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function confidenceTone(c: number): 'success' | 'warn' | 'danger' {
  if (c >= 0.8) return 'success';
  if (c >= 0.6) return 'warn';
  return 'danger';
}

function formatTs(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}
