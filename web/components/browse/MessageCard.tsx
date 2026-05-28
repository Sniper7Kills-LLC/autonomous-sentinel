import Link from 'next/link';
import { Badge, MessageTypeBadge } from '@/components/ui/Badge';
import type { DisplayMessage } from '@/lib/messages/types';
import styles from './MessageCard.module.css';

interface MessageCardProps {
  message: DisplayMessage;
}

export function MessageCard({ message }: MessageCardProps) {
  const ts = formatBroadcastTs(message.broadcastTs);
  const body = message.body ?? '';
  const truncated = body.length > 320;
  const display = truncated ? body.slice(0, 320) + '…' : body;
  return (
    <Link href={`/message?id=${encodeURIComponent(message.id)}`} className={styles.link}>
      <article className={styles.card} data-type={message.type}>
        <div className={styles.top}>
          <MessageTypeBadge type={message.type} />
          <span className={styles.ts}>{ts}</span>
          <span className={styles.spacer} />
          {message.flaggedForReview && <Badge tone="warn">FLAGGED</Badge>}
          {typeof message.confidence === 'number' && (
            <Badge tone={confidenceTone(message.confidence)}>
              CONF {message.confidence.toFixed(2)}
            </Badge>
          )}
        </div>
        {(message.sender || message.receiver) && (
          <div className={styles.callsigns}>
            {message.sender && <span className={styles.callsign}>{message.sender}</span>}
            <span className={styles.arrow} aria-hidden>
              →
            </span>
            {message.receiver && <span className={styles.callsign}>{message.receiver}</span>}
          </div>
        )}
        {body && <p className={`${styles.body} ${truncated ? styles.bodyFade : ''}`}>{display}</p>}
      </article>
    </Link>
  );
}

function confidenceTone(c: number): 'success' | 'warn' | 'danger' {
  if (c >= 0.8) return 'success';
  if (c >= 0.6) return 'warn';
  return 'danger';
}

function formatBroadcastTs(ts: string): string {
  if (!ts) return '';
  // Render ISO UTC in monospace-friendly slice. Display-only — full
  // localisation is a downstream concern when the per-user timezone
  // toggle (CLAUDE.md → Time) lands.
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}
